import { describe, expect, it } from 'vitest'
import { AudioDecodeError } from './pcm'
import { looksLikeWav, parseWav, readWavFrames, wavChunks } from './wav'

interface Spec {
  tag?: number
  bits?: number
  channels?: number
  rate?: number
  data?: Uint8Array
  /** What the data chunk header claims; defaults to the real length. */
  declared?: number
  extensible?: { validBits: number; subTag: number }
  before?: [string, Uint8Array][]
  rf64?: boolean
  noFmt?: boolean
  noData?: boolean
  blockAlign?: number
}

/** A flexible WAV builder, so each exotic variant can be tested in isolation. */
function wav(spec: Spec = {}): Uint8Array {
  const { tag = 1, bits = 16, channels = 1, rate = 44100, data = new Uint8Array(0), extensible } = spec
  const parts: Uint8Array[] = []
  const chunk = (id: string, body: Uint8Array, sizeOverride?: number) => {
    const head = new Uint8Array(8)
    for (let i = 0; i < 4; i++) head[i] = id.charCodeAt(i)
    new DataView(head.buffer).setUint32(4, sizeOverride ?? body.length, true)
    parts.push(head, body)
    if (body.length % 2 === 1) parts.push(new Uint8Array(1)) // pad byte
  }

  if (spec.rf64) {
    const ds64 = new Uint8Array(28)
    const v = new DataView(ds64.buffer)
    v.setUint32(8, data.length >>> 0, true)
    v.setUint32(12, Math.floor(data.length / 4294967296), true)
    chunk('ds64', ds64)
  }
  if (!spec.noFmt) {
    const size = extensible ? 40 : 16
    const fmt = new Uint8Array(size)
    const v = new DataView(fmt.buffer)
    v.setUint16(0, extensible ? 0xfffe : tag, true)
    v.setUint16(2, channels, true)
    v.setUint32(4, rate, true)
    v.setUint32(8, rate * channels * (bits / 8), true)
    v.setUint16(12, spec.blockAlign ?? channels * (bits / 8), true)
    v.setUint16(14, bits, true)
    if (extensible) {
      v.setUint16(16, 22, true)
      v.setUint16(18, extensible.validBits, true)
      v.setUint32(20, 3, true)
      v.setUint16(24, extensible.subTag, true) // first two bytes of the sub-format GUID
    }
    chunk('fmt ', fmt)
  }
  for (const [id, body] of spec.before ?? []) chunk(id, body)
  if (!spec.noData) chunk('data', data, spec.declared)

  const body = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(12 + body)
  const view = new DataView(out.buffer)
  const ascii = (o: number, s: string) => [...s].forEach((c, i) => (out[o + i] = c.charCodeAt(0)))
  ascii(0, spec.rf64 ? 'RF64' : 'RIFF')
  view.setUint32(4, spec.rf64 ? 0xffffffff : 4 + body, true)
  ascii(8, 'WAVE')
  let o = 12
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

const i16 = (...v: number[]) => new Uint8Array(Int16Array.from(v).buffer)
const f32 = (...v: number[]) => new Uint8Array(Float32Array.from(v).buffer)
const f64 = (...v: number[]) => new Uint8Array(Float64Array.from(v).buffer)
const i32 = (...v: number[]) => new Uint8Array(Int32Array.from(v).buffer)
const i24 = (...v: number[]) => Uint8Array.from(v.flatMap((x) => [x & 0xff, (x >> 8) & 0xff, (x >> 16) & 0xff]))

const decode = (bytes: Uint8Array) => {
  const info = parseWav(bytes)
  return { info, pcm: readWavFrames(bytes, info, 0, info.frames) }
}

describe('parseWav: formats', () => {
  it('reads 16-bit PCM', () => {
    const { info, pcm } = decode(wav({ data: i16(0, 16384, -16384, 32767, -32768) }))
    expect(info).toMatchObject({ encoding: 'pcm', bitsPerSample: 16, channels: 1, sampleRate: 44100, frames: 5, truncated: false, rf64: false })
    expect([...pcm[0]!]).toEqual([0, 0.5, -0.5, 32767 / 32768, -1])
  })

  it('reads 8-bit unsigned PCM', () => {
    const { pcm } = decode(wav({ bits: 8, data: Uint8Array.of(128, 255, 0, 192) }))
    expect([...pcm[0]!]).toEqual([0, 127 / 128, -1, 0.5])
  })

  it('reads 24-bit PCM with sign extension', () => {
    const { pcm } = decode(wav({ bits: 24, data: i24(0, 4194304, -4194304, 8388607, -8388608) }))
    expect([...pcm[0]!]).toEqual([0, 0.5, -0.5, 8388607 / 8388608, -1])
  })

  it('reads 32-bit PCM', () => {
    const { pcm } = decode(wav({ bits: 32, data: i32(0, 1073741824, -2147483648) }))
    expect([...pcm[0]!]).toEqual([0, 0.5, -1])
  })

  it('reads 32-bit and 64-bit float', () => {
    expect([...decode(wav({ tag: 3, bits: 32, data: f32(0, 0.25, -0.75) })).pcm[0]!]).toEqual([0, 0.25, -0.75])
    expect([...decode(wav({ tag: 3, bits: 64, data: f64(0, 0.125, -0.5) })).pcm[0]!]).toEqual([0, 0.125, -0.5])
    expect(decode(wav({ tag: 3, bits: 64, data: f64(1) })).info.encoding).toBe('float')
  })

  it('turns NaN and infinity in float files into silence', () => {
    const { pcm } = decode(wav({ tag: 3, bits: 32, data: f32(NaN, Infinity, -Infinity, 0.5) }))
    expect([...pcm[0]!]).toEqual([0, 0, 0, 0.5])
  })

  it('expands A-law and mu-law', () => {
    const alaw = decode(wav({ tag: 6, bits: 8, data: Uint8Array.of(0xd5, 0x55) })).pcm[0]!
    expect(alaw[0]).toBeCloseTo(8 / 32768, 8)
    expect(alaw[1]).toBeCloseTo(-8 / 32768, 8)
    const mulaw = decode(wav({ tag: 7, bits: 8, data: Uint8Array.of(0xff, 0x00, 0x80) })).pcm[0]!
    expect(mulaw[0]).toBe(0)
    expect(mulaw[1]).toBeCloseTo(-32124 / 32768, 6)
    expect(mulaw[2]).toBeCloseTo(32124 / 32768, 6)
  })

  it('understands WAVE_FORMAT_EXTENSIBLE, including a 20-bit payload in a 24-bit container', () => {
    const { info, pcm } = decode(wav({ bits: 24, channels: 1, extensible: { validBits: 20, subTag: 1 }, data: i24(4194304) }))
    expect(info).toMatchObject({ encoding: 'pcm', bitsPerSample: 24, validBits: 20 })
    expect(pcm[0]![0]).toBe(0.5)
    expect(decode(wav({ bits: 32, tag: 3, extensible: { validBits: 32, subTag: 3 }, data: f32(0.5) })).info.encoding).toBe('float')
  })

  it('keeps channels separate (6 channels)', () => {
    const frame = (n: number) => i16(...[1, 2, 3, 4, 5, 6].map((c) => c * 1000 * n))
    const bytes = wav({ channels: 6, data: Uint8Array.of(...frame(1), ...frame(-1)) })
    const { info, pcm } = decode(bytes)
    expect(info).toMatchObject({ channels: 6, frames: 2, blockAlign: 12 })
    expect(pcm.map((c) => Math.round(c[0]! * 32768))).toEqual([1000, 2000, 3000, 4000, 5000, 6000])
    expect(pcm.map((c) => Math.round(c[1]! * 32768))).toEqual([-1000, -2000, -3000, -4000, -5000, -6000])
  })
})

describe('parseWav: container quirks', () => {
  it('skips unknown chunks, including odd-sized ones with a pad byte', () => {
    const bytes = wav({ before: [['LIST', Uint8Array.of(1, 2, 3)], ['junk', new Uint8Array(10)], ['bext', Uint8Array.of(9)]], data: i16(100, 200) })
    expect(decode(bytes).info.frames).toBe(2)
  })

  it('finds a data chunk that comes before fmt as long as both exist', () => {
    const noFmt = wav({ noFmt: true, data: i16(1) })
    expect(() => parseWav(noFmt)).toThrow(/fmt/)
  })

  it('treats a length of 0 or 0xFFFFFFFF as "until the end of the file" (streamed WAV)', () => {
    for (const declared of [0, 0xffffffff]) {
      const { info } = decode(wav({ data: i16(1, 2, 3, 4), declared }))
      expect(info.frames).toBe(4)
      expect(info.truncated).toBe(false)
    }
  })

  it('reports a file that is shorter than its header claims, and decodes what is there', () => {
    const { info, pcm } = decode(wav({ data: i16(1, 2, 3), declared: 1000 }))
    expect(info.truncated).toBe(true)
    expect(info.frames).toBe(3)
    expect(pcm[0]).toHaveLength(3)
  })

  it('ignores a partial trailing frame', () => {
    const data = Uint8Array.of(...i16(1, 2, 3, 4), 7) // 2-channel frames: 2 whole frames + 1 stray byte
    const { info } = decode(wav({ channels: 2, data }))
    expect(info.frames).toBe(2)
  })

  it('ignores chunks after the data (tags, cue points)', () => {
    const bytes = wav({ data: i16(1, 2) })
    const withTail = new Uint8Array(bytes.length + 20)
    withTail.set(bytes)
    expect(decode(withTail).info.frames).toBe(2) // the declared size bounds the audio, so trailing metadata is never played
  })

  it('reads RF64 files whose sizes live in the ds64 chunk', () => {
    const bytes = wav({ rf64: true, declared: 0xffffffff, data: i16(5, 6, 7) })
    const { info, pcm } = decode(bytes)
    expect(info.rf64).toBe(true)
    expect(info.frames).toBe(3)
    expect(Math.round(pcm[0]![2]! * 32768)).toBe(7)
  })

  it('computes block alignment itself rather than trusting a damaged header field', () => {
    const { info } = decode(wav({ channels: 2, bits: 16, blockAlign: 7, data: i16(1, 2, 3, 4) }))
    expect(info.blockAlign).toBe(4)
    expect(info.frames).toBe(2)
  })

  it('recognises the signature', () => {
    expect(looksLikeWav(wav())).toBe(true)
    expect(looksLikeWav(new Uint8Array(12))).toBe(false)
    expect(looksLikeWav(Uint8Array.of(0x52, 0x49, 0x46, 0x46))).toBe(false)
  })
})

describe('parseWav: errors', () => {
  const failsWith = (bytes: Uint8Array, code: AudioDecodeError['code'], message?: RegExp) => {
    try {
      parseWav(bytes)
    } catch (e) {
      expect(e).toBeInstanceOf(AudioDecodeError)
      expect((e as AudioDecodeError).code).toBe(code)
      if (message) expect((e as AudioDecodeError).message).toMatch(message)
      return
    }
    throw new Error('expected parseWav to throw')
  }

  it('rejects data that is not a WAV file', () => failsWith(new Uint8Array(64), 'corrupt', /RIFF/))
  it('rejects a file without a fmt chunk', () => failsWith(wav({ noFmt: true, data: i16(1) }), 'corrupt', /fmt/))
  it('rejects a file without a data chunk', () => failsWith(wav({ noData: true }), 'corrupt', /data/))
  it('rejects zero channels', () => failsWith(wav({ channels: 0, data: i16(1) }), 'corrupt'))
  it('rejects a zero sample rate', () => failsWith(wav({ rate: 0, data: i16(1) }), 'corrupt'))
  it('rejects encodings it cannot decode (IMA ADPCM)', () => failsWith(wav({ tag: 0x11, bits: 4, data: new Uint8Array(8) }), 'unsupported', /format tag 17/))
  it('rejects odd sample sizes', () => {
    failsWith(wav({ bits: 12, data: new Uint8Array(4) }), 'unsupported', /12-bit/)
    failsWith(wav({ tag: 3, bits: 16, data: new Uint8Array(4) }), 'unsupported')
  })
})

describe('wavChunks / readWavFrames', () => {
  const ramp = Array.from({ length: 1000 }, (_, i) => i - 500)
  const bytes = wav({ channels: 2, data: i16(...ramp) }) // 500 stereo frames

  it('yields the whole file in chunks of the requested size', () => {
    const info = parseWav(bytes)
    const chunks = [...wavChunks(bytes, info, 128)]
    expect(chunks.map((c) => c[0]?.length)).toEqual([128, 128, 128, 116])
    const joined = chunks.flatMap((c) => [...c[0]!])
    expect(joined).toEqual(Array.from({ length: 500 }, (_, i) => (i * 2 - 500) / 32768))
  })

  it('reads an arbitrary window and clamps at the end', () => {
    const info = parseWav(bytes)
    const window = readWavFrames(bytes, info, 10, 3)
    expect(Math.round(window[1]![0]! * 32768)).toBe(11 * 1 - 500 + 10 * 1) // (second channel of frame 10) = ramp[21]
    expect(readWavFrames(bytes, info, 498, 10)[0]).toHaveLength(2)
    expect(readWavFrames(bytes, info, 600, 10)[0]).toHaveLength(0)
    expect(readWavFrames(bytes, info, 0, 0)[0]).toHaveLength(0)
  })

  it('works on a view into a larger buffer (non-zero byteOffset)', () => {
    const padded = new Uint8Array(bytes.length + 33)
    padded.set(bytes, 33)
    const view = padded.subarray(33)
    const info = parseWav(view)
    expect(info.frames).toBe(500)
    expect(readWavFrames(view, info, 0, 1)[0]![0]).toBe(-500 / 32768)
  })
})
