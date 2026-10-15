import { describe, expect, it } from 'vitest'
import { seededRandom } from '../dsp'
import { encodeFlac, floatToInt } from '../../test-utils/flac-encoder'
import type { FlacEncodeOptions } from '../../test-utils/flac-encoder'
import { FlacDecoder, decodeFlac, frameToChunk, looksLikeFlac, parseFlacMetadata } from './flac'
import { AudioDecodeError } from './pcm'

/** Deterministic test signal: two sines and a little noise, scaled to the bit depth and kept in range. */
function signal(length: number, bits: number, seed = 1, phase = 0): Int32Array {
  const rand = seededRandom(seed)
  const peak = 2 ** (bits - 1) - 1
  return Int32Array.from({ length }, (_, i) => {
    const v = 0.55 * Math.sin((2 * Math.PI * 220 * (i + phase)) / 44100) + 0.25 * Math.sin((2 * Math.PI * 1760 * i) / 44100) + 0.04 * (rand() * 2 - 1)
    return Math.max(-peak - 1, Math.min(peak, Math.round(v * peak)))
  })
}

const base = (over: Partial<FlacEncodeOptions> = {}): FlacEncodeOptions => ({ sampleRate: 44100, bitsPerSample: 16, ...over })

/** Encode, decode with MD5 verification, and assert a bit-exact round trip. */
function roundTrip(channels: Int32Array[], options: FlacEncodeOptions) {
  const bytes = encodeFlac(channels, options)
  const out = decodeFlac(bytes, { verifyMd5: true })
  expect(out.warnings).toEqual([])
  expect(out.md5Status).toBe('verified')
  expect(out.channels).toBe(channels.length)
  expect(out.length).toBe(channels[0]?.length)
  channels.forEach((c, i) => expect(out.pcm[i]?.every((v, n) => v === c[n])).toBe(true))
  return { bytes, out }
}

describe('metadata', () => {
  const pcm = [signal(5000, 16), signal(5000, 16, 2)]

  it('reads STREAMINFO', () => {
    const { info } = parseFlacMetadata(encodeFlac(pcm, base({ blockSize: 1024 })))
    expect(info).toMatchObject({ sampleRate: 44100, channels: 2, bitsPerSample: 16, totalSamples: 5000, minBlockSize: 904, maxBlockSize: 1024 })
    expect(info.md5.some((b) => b !== 0)).toBe(true)
  })

  it.each([
    [8000, 1, 8],
    [96000, 2, 24],
    [192000, 6, 20],
    [22050, 8, 12],
  ])('stores %i Hz / %i ch / %i bit', (sampleRate, channels, bits) => {
    const data = Array.from({ length: channels }, (_, c) => signal(600, bits, c + 1))
    const { info } = parseFlacMetadata(encodeFlac(data, base({ sampleRate, bitsPerSample: bits })))
    expect(info).toMatchObject({ sampleRate, channels, bitsPerSample: bits, totalSamples: 600 })
  })

  it('reads Vorbis comments, a seek table and counts other blocks', () => {
    const bytes = encodeFlac(pcm, base({ blockSize: 1000, seekEvery: 2, padding: 64, vorbis: { vendor: 'wavelocal test', comments: ['TITLE=Tone', 'ARTIST=Synth', 'ÄÖ=ünïcode'] } }))
    const meta = parseFlacMetadata(bytes)
    expect(meta.vendor).toBe('wavelocal test')
    expect(meta.comments).toEqual(['TITLE=Tone', 'ARTIST=Synth', 'ÄÖ=ünïcode'])
    expect(meta.seekTable).toEqual([
      { sample: 0, offset: 0, samples: 1000 },
      { sample: 2000, offset: expect.any(Number), samples: 1000 },
      { sample: 4000, offset: expect.any(Number), samples: 1000 },
    ])
    expect(meta.seekTable[1]?.offset).toBeGreaterThan(0)
    expect(decodeFlac(bytes).length).toBe(5000)
  })

  it('points the seek table at real frames', () => {
    const bytes = encodeFlac(pcm, base({ blockSize: 1000, seekEvery: 1 }))
    const meta = parseFlacMetadata(bytes)
    for (const point of meta.seekTable) {
      const at = meta.firstFrameOffset + point.offset
      expect(bytes[at]).toBe(0xff)
      expect((bytes[at + 1] ?? 0) & 0xfe).toBe(0xf8)
    }
  })

  it('skips a leading ID3v2 tag', () => {
    const id3 = new Uint8Array(10 + 300)
    id3.set([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 2, 0x2c]) // "ID3", v2.3, size 300 (syncsafe 0x02 0x2c)
    const bytes = encodeFlac(pcm, base({ id3v2: id3 }))
    expect(looksLikeFlac(bytes)).toBe(true)
    expect(roundTrip(pcm, base({ id3v2: id3 })).out.length).toBe(5000)
  })

  it('recognises FLAC and rejects other data', () => {
    expect(looksLikeFlac(encodeFlac(pcm, base()))).toBe(true)
    expect(looksLikeFlac(new Uint8Array(64))).toBe(false)
    expect(looksLikeFlac(Uint8Array.of(0x66, 0x4c))).toBe(false)
    expect(() => parseFlacMetadata(new Uint8Array(64))).toThrow(AudioDecodeError)
  })

  it('rejects a stream with no STREAMINFO or one cut off inside the metadata', () => {
    const bytes = encodeFlac(pcm, base())
    expect(() => parseFlacMetadata(bytes.slice(0, 20))).toThrow(/cut short/)
    const noInfo = Uint8Array.from([0x66, 0x4c, 0x61, 0x43, 0x81, 0, 0, 4, 0, 0, 0, 0]) // PADDING only, flagged last
    expect(() => parseFlacMetadata(noInfo)).toThrow(/STREAMINFO/)
  })
})

describe('subframe types', () => {
  const mono = [signal(9000, 16)]

  it.each([['constant'], ['verbatim'], ['fixed'], ['lpc'], ['auto']] as const)('%s subframes round-trip exactly', (mode) => {
    const data = mode === 'constant' ? [new Int32Array(5000).fill(-1234)] : mono
    roundTrip(data, base({ subframe: mode, blockSize: 2048 }))
  })

  it.each([0, 1, 2, 3, 4])('fixed predictor of order %i', (order) => {
    roundTrip(mono, base({ subframe: 'fixed', order, blockSize: 1024 }))
  })

  it.each([1, 2, 3, 4, 8, 12, 16, 24, 32])('LPC of order %i', (order) => {
    roundTrip([signal(4096, 16)], base({ subframe: 'lpc', order, blockSize: 4096 }))
  })

  it.each([5, 8, 12, 15])('LPC with %i-bit coefficients', (lpcPrecision) => {
    roundTrip(mono, base({ subframe: 'lpc', order: 8, lpcPrecision, blockSize: 2048 }))
  })

  it('silence and DC offsets become constant subframes', () => {
    const { bytes } = roundTrip([new Int32Array(8192), new Int32Array(8192).fill(77)], base({ blockSize: 4096 }))
    expect(bytes.length).toBeLessThan(200)
  })

  it('compresses a tone far below its raw size', () => {
    const { bytes } = roundTrip([signal(44100, 16)], base({ blockSize: 4096 }))
    expect(bytes.length).toBeLessThan(44100 * 2 * 0.85) // a noisy tone: still clearly smaller than raw PCM
  })

  it('wasted bits: samples that are multiples of 8', () => {
    const shifted = signal(4000, 16).map((v) => v & ~7)
    roundTrip([shifted], base({ subframe: 'fixed', order: 1, blockSize: 1000 }))
    roundTrip([shifted], base({ subframe: 'lpc', order: 4, blockSize: 1000 }))
  })

  it('wasted bits can be switched off in the encoder, with the same result', () => {
    const shifted = signal(2000, 16).map((v) => v & ~15)
    roundTrip([shifted], base({ wastedBits: false, blockSize: 500 }))
  })
})

describe('residual coding', () => {
  it('Rice2 (5-bit parameters) round-trips', () => {
    roundTrip([signal(6000, 24)], base({ bitsPerSample: 24, riceMethod: 1, blockSize: 2000 }))
  })

  it('handles white noise at full scale (escape partitions and large Rice parameters)', () => {
    const rand = seededRandom(9)
    const noise = Int32Array.from({ length: 6000 }, () => Math.round((rand() * 2 - 1) * 32767))
    roundTrip([noise], base({ blockSize: 1500 }))
    roundTrip([noise], base({ blockSize: 1500, allowEscape: false, riceMethod: 1 }))
  })

  it.each([0, 1, 3, 6])('with up to %i partition orders', (maxPartitionOrder) => {
    roundTrip([signal(8192, 16)], base({ maxPartitionOrder, blockSize: 4096 }))
  })

  it('uses a different partition layout on different content without trouble', () => {
    const burst = signal(8192, 16)
    burst.fill(0, 0, 6000) // silence followed by signal: very uneven residual energy
    roundTrip([burst], base({ blockSize: 8192, subframe: 'fixed', order: 2 }))
  })
})

describe('channels and stereo decorrelation', () => {
  const left = signal(8000, 16, 1)
  const right = signal(8000, 16, 2, 40) // correlated with the left channel but not identical

  it.each(['independent', 'leftside', 'rightside', 'midside', 'auto'] as const)('%s stereo is lossless', (stereo) => {
    roundTrip([left, right], base({ stereo, blockSize: 2048 }))
  })

  it('stereo modes are lossless at full scale (the side channel needs one extra bit)', () => {
    const a = Int32Array.from({ length: 3000 }, (_, i) => (i % 2 ? 32767 : -32768))
    const b = Int32Array.from({ length: 3000 }, (_, i) => (i % 2 ? -32768 : 32767))
    for (const stereo of ['leftside', 'rightside', 'midside'] as const) roundTrip([a, b], base({ stereo, blockSize: 1000 }))
  })

  it('mid/side keeps the lowest bit (odd and even sums)', () => {
    const a = Int32Array.from({ length: 2000 }, (_, i) => (i * 7) % 200 - 100)
    const b = Int32Array.from({ length: 2000 }, (_, i) => (i * 3) % 150 - 75)
    roundTrip([a, b], base({ stereo: 'midside', blockSize: 500 }))
  })

  it.each([1, 3, 4, 5, 6, 7, 8])('%i channels', (count) => {
    roundTrip(Array.from({ length: count }, (_, c) => signal(2500, 16, c + 1, c * 7)), base({ blockSize: 1000 }))
  })
})

describe('bit depths and sample rates', () => {
  it.each([8, 12, 16, 20, 24])('%i-bit audio', (bits) => {
    roundTrip([signal(5000, bits, 1), signal(5000, bits, 2, 9)], base({ bitsPerSample: bits, blockSize: 1500 }))
  })

  it('24-bit extremes', () => {
    const extreme = Int32Array.from({ length: 2000 }, (_, i) => (i % 3 === 0 ? 8388607 : i % 3 === 1 ? -8388608 : 0))
    roundTrip([extreme], base({ bitsPerSample: 24, blockSize: 500 }))
  })

  it.each([8000, 11025, 16000, 22050, 24000, 32000, 44100, 48000, 88200, 96000, 176400, 192000])('standard rate %i Hz', (sampleRate) => {
    roundTrip([signal(1500, 16)], base({ sampleRate, blockSize: 700 }))
  })

  it.each([12345, 44101, 123450, 7000, 255000])('unusual rate %i Hz (explicit header fields)', (sampleRate) => {
    const { out } = roundTrip([signal(1500, 16)], base({ sampleRate: Math.min(sampleRate, 655350), blockSize: 700 }))
    expect(out.sampleRate).toBe(Math.min(sampleRate, 655350))
  })

  it('takes the rate from STREAMINFO when frame headers defer to it', () => {
    const { out } = roundTrip([signal(1500, 16)], base({ sampleRate: 37800, rateFromStreamInfo: true, blockSize: 700 }))
    expect(out.sampleRate).toBe(37800)
  })
})

describe('block sizes', () => {
  it.each([16, 100, 192, 256, 576, 1000, 1152, 4096, 4608, 20000, 32768])('fixed block size %i (the last block is short)', (blockSize) => {
    roundTrip([signal(33000, 16)], base({ blockSize, subframe: 'fixed', order: 2 }))
  })

  it('variable block sizes, signalled by sample number', () => {
    const { out } = roundTrip([signal(20000, 16), signal(20000, 16, 2)], base({ blockSizes: [4096, 1000, 256, 5000, 333, 2048], subframe: 'fixed', order: 1 }))
    expect(out.length).toBe(20000)
  })

  it('reports each frame position in order', () => {
    const bytes = encodeFlac([signal(9000, 16)], base({ blockSizes: [1000, 2000, 3000], subframe: 'fixed', order: 1 }))
    const frames = [...new FlacDecoder(bytes).frames()]
    expect(frames.map((f) => f.sampleNumber)).toEqual([0, 1000, 3000, 6000, 7000])
    expect(frames.map((f) => f.blockSize)).toEqual([1000, 2000, 3000, 1000, 2000]) // the size list repeats
    const fixed = [...new FlacDecoder(encodeFlac([signal(9000, 16)], base({ blockSize: 4000 }))).frames()]
    expect(fixed.map((f) => f.sampleNumber)).toEqual([0, 4000, 8000])
  })

  it('handles a single tiny block and an empty stream', () => {
    roundTrip([signal(1, 16)], base({ blockSize: 16 }))
    expect(decodeFlac(encodeFlac([new Int32Array(0)], base())).length).toBe(0)
  })
})

describe('streaming and conversion helpers', () => {
  const data = [signal(10000, 16), signal(10000, 16, 3)]
  const bytes = encodeFlac(data, base({ blockSize: 2500 }))

  it('yields frames lazily and in order', () => {
    const decoder = new FlacDecoder(bytes)
    const iterator = decoder.frames()
    const first = iterator.next().value
    expect(first?.sampleNumber).toBe(0)
    expect(first?.blockSize).toBe(2500)
    expect(first?.samples[0]?.[10]).toBe(data[0]?.[10])
    expect(first?.concealed).toBe(false)
    expect([...iterator]).toHaveLength(3)
  })

  it('frameToChunk scales to [-1, 1) exactly', () => {
    const frame = new FlacDecoder(bytes).frames().next().value
    if (!frame) throw new Error('no frame')
    const chunk = frameToChunk(frame)
    expect(chunk).toHaveLength(2)
    expect(chunk[0]?.[100]).toBe((data[0]?.[100] ?? 0) / 32768)
  })

  it('24-bit samples survive the float conversion without rounding', () => {
    const pcm = [signal(3000, 24)]
    const frame = new FlacDecoder(encodeFlac(pcm, base({ bitsPerSample: 24 }))).frames().next().value
    if (!frame) throw new Error('no frame')
    const chunk = frameToChunk(frame)
    for (let i = 0; i < 3000; i += 97) expect(Math.round((chunk[0]?.[i] ?? 0) * 8388608)).toBe(pcm[0]?.[i])
  })

  it('floatToInt maps full scale to full scale', () => {
    expect([...floatToInt(Float32Array.of(0, 1, -1, 0.5, 2, -2), 16)]).toEqual([0, 32767, -32767, 16384, 32767, -32768])
  })
})

describe('integrity checks', () => {
  const data = [signal(12000, 16), signal(12000, 16, 5)]
  const good = encodeFlac(data, base({ blockSize: 3000, stereo: 'independent', subframe: 'verbatim' })) // verbatim: damage cannot hide in a prediction
  const firstFrame = parseFlacMetadata(good).firstFrameOffset

  const flip = (bytes: Uint8Array, at: number) => {
    const copy = bytes.slice()
    copy[at] = (copy[at] ?? 0) ^ 0x10
    return copy
  }

  it('MD5 verification is off unless asked for', () => {
    const decoder = new FlacDecoder(good)
    for (const f of decoder.frames()) void f
    expect(decoder.md5Status).toBe('skipped')
  })

  it('MD5 verification passes for an intact stream', () => {
    const decoder = new FlacDecoder(good, { verifyMd5: true })
    for (const f of decoder.frames()) void f
    expect(decoder.md5Status).toBe('verified')
    expect(decoder.warnings).toEqual([])
  })

  it('a wrong MD5 in STREAMINFO is reported as a mismatch (the audio itself is still decoded)', () => {
    const bad = good.slice()
    bad[4 + 4 + 20] = (bad[4 + 4 + 20] ?? 0) ^ 0xff // inside the 16-byte digest
    const decoder = new FlacDecoder(bad, { verifyMd5: true })
    const frames = [...decoder.frames()]
    expect(frames).toHaveLength(4)
    expect(decoder.md5Status).toBe('mismatch')
    expect(decoder.warnings.join()).toMatch(/MD5/)
  })

  it('an all-zero MD5 means "unknown", not "wrong"', () => {
    const bytes = encodeFlac(data, base({ writeMd5: false }))
    const decoder = new FlacDecoder(bytes, { verifyMd5: true })
    for (const f of decoder.frames()) void f
    expect(decoder.md5Status).toBe('unavailable')
  })

  it('warns when the stream length disagrees with STREAMINFO', () => {
    const decoder = new FlacDecoder(encodeFlac(data, base({ writeTotalSamples: false })))
    for (const f of decoder.frames()) void f
    expect(decoder.warnings).toEqual([]) // an unknown length is fine
    const lying = encodeFlac(data, base({ blockSize: 3000 }))
    // claim 1 million samples in the header's 36-bit field (bytes 4+4+10.. of STREAMINFO)
    const view = new DataView(lying.buffer)
    view.setUint32(4 + 4 + 14, 1_000_000, false)
    const d2 = new FlacDecoder(lying)
    for (const f of d2.frames()) void f
    expect(d2.warnings.join()).toMatch(/declares/)
  })

  it('throws on a corrupted frame header (CRC-8)', () => {
    expect(() => decodeFlac(flip(good, firstFrame + 4))).toThrow(/CRC/)
  })

  it('throws on corrupted audio data (CRC-16)', () => {
    expect(() => decodeFlac(flip(good, firstFrame + 400))).toThrow(/CRC mismatch/)
  })

  it('throws on a stream cut mid-frame', () => {
    expect(() => decodeFlac(good.slice(0, good.length - 500))).toThrow(AudioDecodeError)
  })

  it('ignores a trailing ID3v1 tag but not large trailing garbage', () => {
    const tagged = new Uint8Array(good.length + 128)
    tagged.set(good)
    tagged.set([0x54, 0x41, 0x47], good.length) // "TAG"
    expect(decodeFlac(tagged).length).toBe(12000)
    const junk = new Uint8Array(good.length + 5000).fill(0x11)
    junk.set(good)
    expect(() => decodeFlac(junk)).toThrow(/sync lost/)
  })

  describe('lenient mode', () => {
    it('replaces a damaged frame with silence and carries on', () => {
      const bad = flip(good, firstFrame + 400) // inside frame 0
      const out = decodeFlac(bad, { lenient: true, verifyMd5: true })
      expect(out.length).toBe(12000)
      expect(out.warnings.join()).toMatch(/Concealed a damaged frame/)
      expect(out.md5Status).toBe('mismatch')
      expect(out.pcm[0]?.slice(0, 3000).every((v) => v === 0)).toBe(true)
      // everything after the damage is bit-exact
      expect(out.pcm[0]?.slice(3000).every((v, i) => v === data[0]?.[3000 + i])).toBe(true)
      expect(out.pcm[1]?.slice(3000).every((v, i) => v === data[1]?.[3000 + i])).toBe(true)
    })

    it('flags concealed frames', () => {
      const decoder = new FlacDecoder(flip(good, firstFrame + 400), { lenient: true })
      const frames = [...decoder.frames()]
      expect(frames.map((f) => f.concealed)).toEqual([true, false, false, false])
    })

    it('survives garbage between frames by resynchronising', () => {
      const meta = parseFlacMetadata(good)
      const second = [...new FlacDecoder(good).frames()][1]?.byteOffset ?? 0
      const damaged = new Uint8Array(good.length + 77)
      damaged.set(good.subarray(0, second))
      damaged.fill(0x33, second, second + 77)
      damaged.set(good.subarray(second), second + 77)
      const out = decodeFlac(damaged, { lenient: true })
      expect(out.length).toBe(12000)
      expect(out.warnings.join()).toMatch(/Skipped 77 bytes/)
      expect(meta.firstFrameOffset).toBe(firstFrame)
    })

    it('recovers a truncated final frame as silence', () => {
      const out = decodeFlac(good.slice(0, good.length - 500), { lenient: true })
      expect(out.length).toBe(12000)
      expect(out.warnings.length).toBeGreaterThan(0)
    })

    it('does not hide unsupported formats', () => {
      const wide = encodeFlac([signal(500, 24)], base({ bitsPerSample: 24 }))
      const bytes = wide.slice()
      // pretend the stream is 32-bit: STREAMINFO bits-per-sample field (5 bits) = 31
      const view = new DataView(bytes.buffer)
      view.setUint32(4 + 4 + 10, (view.getUint32(4 + 4 + 10, false) & ~(31 << 4)) | (31 << 4), false)
      expect(() => decodeFlac(bytes, { lenient: true })).toThrow(/32-bit/)
    })
  })

  it('refuses sample sizes above 24 bits with a clear, typed error', () => {
    const bytes = encodeFlac([signal(500, 24)], base({ bitsPerSample: 24 }))
    const view = new DataView(bytes.buffer)
    view.setUint32(4 + 4 + 10, (view.getUint32(4 + 4 + 10, false) & ~(31 << 4)) | (31 << 4), false)
    try {
      decodeFlac(bytes)
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(AudioDecodeError)
      expect((e as AudioDecodeError).code).toBe('unsupported')
    }
  })
})
