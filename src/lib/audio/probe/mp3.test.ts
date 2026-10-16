import { describe, expect, it } from 'vitest'
import { bytesSource } from '../source'
import { probeMp3 } from './mp3'
import { buildMp3, cat, countingSource, id3v2Blank, mp3Seconds, virtualSource } from '../../../test-utils/containers'
import type { Mp3Options } from '../../../test-utils/containers'

const probe = (bytes: Uint8Array, options?: Parameters<typeof probeMp3>[1]) => probeMp3(bytesSource(bytes), options)

/** A small seeded generator, so the "random" inputs are the same on every run. */
function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('probeMp3: constant bitrate', () => {
  it('estimates a CBR file with no Xing header from its size', async () => {
    const r = await probe(buildMp3({ frames: 1000 }))
    expect(r?.format).toMatchObject({ container: 'mp3', codec: 'mp3', sampleRate: 44100, channels: 2, bitrate: 128000, vbr: false, lossless: false, bitDepth: 0 })
    expect(r?.duration).toBeCloseTo(mp3Seconds(1000), 1)
    expect(r?.tags).toEqual({})
    expect(r?.picture).toBeNull()
  })

  it('reads the exact frame count from an Info header and reports the nominal bitrate', async () => {
    // with the encoder delay trimmed off the duration, bytes / duration would read 128.19 kbps: a constant-bitrate file says 128
    const r = await probe(buildMp3({ frames: 1000, xing: { tag: 'Info', bytes: true, lame: { delay: 576, padding: 1134 } } }))
    expect(r?.duration).toBeCloseTo((1000 * 1152 - 576 - 1134) / 44100, 6)
    expect(r?.format.vbr).toBe(false)
    expect(r?.format.bitrate).toBe(128000)
  })

  it('derives the average bitrate of a Xing (variable bitrate) file from its byte count', async () => {
    const r = await probe(buildMp3({ frames: 1000, vbrKbps: [96, 160], xing: { tag: 'Xing', bytes: true } }))
    expect(r?.format.vbr).toBe(true)
    expect(r?.format.bitrate).toBeGreaterThan(127_000) // the average of 96 and 160 kbps
    expect(r?.format.bitrate).toBeLessThan(129_000)
  })

  it('applies the LAME encoder delay and padding, as other taggers do', async () => {
    const r = await probe(buildMp3({ frames: 2000, xing: { lame: { delay: 576, padding: 1152 } } }))
    expect(r?.duration).toBeCloseTo((2000 * 1152 - 576 - 1152) / 44100, 6)
    expect(r?.format).toMatchObject({ encoderDelay: 576, encoderPadding: 1152 })
  })

  it('ignores LAME delay and padding that cannot be right for the stream length', async () => {
    const r = await probe(buildMp3({ frames: 2, xing: { lame: { delay: 4000, padding: 4000 } } }))
    expect(r?.duration).toBeCloseTo((2 * 1152) / 44100, 6)
    expect(r?.format).toMatchObject({ encoderDelay: 0, encoderPadding: 0 })
  })

  it('calls a Xing header variable bitrate and an Info header constant', async () => {
    expect((await probe(buildMp3({ frames: 100, xing: { tag: 'Xing' } })))?.format.vbr).toBe(true)
    expect((await probe(buildMp3({ frames: 100, xing: { tag: 'Info' } })))?.format.vbr).toBe(false)
  })

  it('reads the frame count from a VBRI header', async () => {
    const r = await probe(buildMp3({ frames: 500, vbri: { frames: 640 } }))
    expect(r?.duration).toBeCloseTo(mp3Seconds(640), 6)
    expect(r?.format.vbr).toBe(true)
  })

  it('falls back to the file size when a Xing header declares no usable frame count', async () => {
    for (const frames of [0, null]) {
      const r = await probe(buildMp3({ frames: 800, xing: { frames } }))
      expect(r?.duration).toBeCloseTo(mp3Seconds(800), 1)
    }
  })

  it('accepts a file that is a single frame', async () => {
    const r = await probe(buildMp3({ frames: 1 }))
    expect(r?.duration).toBeCloseTo(1152 / 44100, 3)
  })
})

describe('probeMp3: where the Xing header lives', () => {
  const layouts: [string, Mp3Options][] = [
    ['MPEG-1 stereo', { frames: 50, xing: { frames: 777 } }],
    ['MPEG-1 mono', { frames: 50, mode: 'mono', xing: { frames: 777 } }],
    ['MPEG-1 CRC-protected', { frames: 50, crc: true, xing: { frames: 777 } }],
    ['MPEG-2 stereo', { frames: 50, version: 2, sampleRate: 24000, bitrateKbps: 64, xing: { frames: 777 } }],
    ['MPEG-2 mono', { frames: 50, version: 2, mode: 'mono', bitrateKbps: 64, xing: { frames: 777 } }],
    ['MPEG-2.5 joint stereo', { frames: 50, version: 2.5, mode: 'joint', sampleRate: 11025, bitrateKbps: 32, xing: { frames: 777 } }],
  ]

  it.each(layouts)('finds it in %s frames and uses that version\'s samples per frame', async (_name, options) => {
    const r = await probe(buildMp3(options))
    expect(r?.duration).toBeCloseTo(mp3Seconds(777, options), 6)
    expect(r?.format.channels).toBe(options.mode === 'mono' ? 1 : 2)
    expect(r?.format.sampleRate).toBe(options.sampleRate ?? (options.version === 2 ? 22050 : options.version === 2.5 ? 11025 : 44100))
  })
})

describe('probeMp3: finding the first frame', () => {
  it('skips an ID3v2 tag, the padding after it and a tag footer', async () => {
    for (const footer of [false, true]) {
      const r = await probe(buildMp3({ frames: 400, id3v2: id3v2Blank(2048, { footer }), gap: 100 }))
      expect(r?.duration).toBeCloseTo(mp3Seconds(400), 1) // a tag counted as audio would add 0.13 s
    }
  })

  it('does not count an ID3v1 trailer as audio', async () => {
    const spec = { version: 2 as const, sampleRate: 22050, bitrateKbps: 8, frames: 2000 }
    const r = await probe(buildMp3({ ...spec, id3v1: true }))
    expect(r?.duration).toBeCloseTo(mp3Seconds(2000, spec), 1) // counted as audio it would add 0.128 s
  })

  it('resynchronises past junk and rejects a lone false sync', async () => {
    // an MPEG-2.5, 8 kHz, mono header that parses fine but is followed by nothing frame-like
    const decoy = Uint8Array.from([0xff, 0xe3, 0x18, 0xc4])
    const junk = cat([0x12, 0x34], decoy, new Uint8Array(200).fill(0x55))
    const r = await probe(buildMp3({ frames: 600, leading: junk }))
    expect(r?.format).toMatchObject({ sampleRate: 44100, channels: 2, bitrate: 128000 })
    expect(r?.duration).toBeCloseTo(mp3Seconds(600), 1)
  })

  it('gives up on an ID3v2 tag that claims to be larger than the file', async () => {
    const lie = id3v2Blank(2048).slice()
    lie.set([0x7f, 0x7f, 0x7f, 0x7f], 6)
    expect(await probe(cat(lie, buildMp3({ frames: 10 })))).toBeNull()
  })
})

describe('probeMp3: layers', () => {
  it('identifies layer II and layer I streams', async () => {
    const mp2 = await probe(buildMp3({ layer: 2, bitrateKbps: 192, sampleRate: 48000, frames: 500 }))
    expect(mp2?.format).toMatchObject({ codec: 'mp2', sampleRate: 48000, bitrate: 192000 })
    expect(mp2?.duration).toBeCloseTo(mp3Seconds(500, { layer: 2, sampleRate: 48000 }), 1)
    const mp1 = await probe(buildMp3({ layer: 1, bitrateKbps: 224, frames: 500 }))
    expect(mp1?.format.codec).toBe('mp1')
    expect(mp1?.duration).toBeCloseTo(mp3Seconds(500, { layer: 1 }), 1)
  })
})

describe('probeMp3: variable bitrate without a header', () => {
  const vbr = { frames: 1500, vbrKbps: [128, 192, 256, 160, 96] }

  it('walks every frame, so the duration is exact where a bitrate estimate would be 30% off', async () => {
    const r = await probe(buildMp3(vbr))
    expect(r?.duration).toBeCloseTo(mp3Seconds(1500), 2)
    expect(r?.format.vbr).toBe(true)
    expect(r?.format.bitrate).toBeGreaterThan(165_000) // the average is 166.4 kbps
    expect(r?.format.bitrate).toBeLessThan(168_000)
  })

  it('extrapolates when the file is longer than the scan budget, without reading all of it', async () => {
    const bytes = buildMp3(vbr)
    const counted = countingSource(bytesSource(bytes))
    const r = await probeMp3(counted, { maxScanBytes: 100_000 })
    expect(bytes.length).toBeGreaterThan(600_000)
    expect(counted.bytes).toBeLessThan(250_000)
    expect(r?.duration).toBeGreaterThan(mp3Seconds(1500) * 0.95)
    expect(r?.duration).toBeLessThan(mp3Seconds(1500) * 1.05)
  })
})

describe('probeMp3: damaged and truncated files', () => {
  it('scales a Xing count that the file cannot hold (a truncated download)', async () => {
    const whole = buildMp3({ frames: 1000, xing: { bytes: true } })
    const r = await probe(whole.slice(0, Math.floor(whole.length * 0.55)))
    expect(r?.duration).toBeGreaterThan(mp3Seconds(1000) * 0.5)
    expect(r?.duration).toBeLessThan(mp3Seconds(1000) * 0.6)
  })

  it('returns null for data that is not MP3', async () => {
    expect(await probe(new Uint8Array(0))).toBeNull()
    expect(await probe(new Uint8Array(3))).toBeNull()
    expect(await probe(new Uint8Array(20_000))).toBeNull()
    expect(await probe(id3v2Blank(5000))).toBeNull() // a tag and nothing else
    const random = mulberry32(7)
    expect(await probe(Uint8Array.from({ length: 50_000 }, () => Math.floor(random() * 256)))).toBeNull()
  })
})

describe('probeMp3: cost', () => {
  it('reads only the head and the tail of a huge file', async () => {
    const head = buildMp3({ frames: 200, id3v2: id3v2Blank(4096) })
    const size = 300 * 1024 * 1024
    const counted = countingSource(virtualSource(size, head))
    const r = await probeMp3(counted)
    expect(counted.bytes).toBeLessThan(80 * 1024)
    expect(counted.reads).toBeLessThan(12)
    expect(r?.duration).toBeCloseTo(((size - 4096) * 8) / 128000, -1)
  })
})
