import { describe, expect, it } from 'vitest'
import { AudioDecodeError, Pcm16Encoder, downmixToStereo, wavHeader } from './pcm'
import type { PcmChunk } from './pcm'

const readWav = async (blob: Blob) => {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const view = new DataView(bytes.buffer)
  const samples = new Int16Array(bytes.buffer, 44, Math.floor((bytes.length - 44) / 2))
  return { bytes, view, samples }
}

const chunk = (...channels: number[][]): PcmChunk => channels.map((c) => Float32Array.from(c))

describe('downmixToStereo', () => {
  it('passes mono and stereo through untouched', () => {
    const mono = chunk([0.1, 0.2])
    const stereo = chunk([0.1], [0.2])
    expect(downmixToStereo(mono)).toBe(mono)
    expect(downmixToStereo(stereo)).toBe(stereo)
  })

  it('folds a centre channel into both sides at -3 dB', () => {
    const [l, r] = downmixToStereo(chunk([0], [0], [1])) // L R C with only the centre active
    const norm = 1 / (1 + Math.SQRT1_2) // the most any side can receive is L + 0.707 * C
    expect(l?.[0]).toBeCloseTo(Math.SQRT1_2 * norm, 6)
    expect(r?.[0]).toBeCloseTo(Math.SQRT1_2 * norm, 6)
  })

  it('keeps left and right where they were', () => {
    const [l, r] = downmixToStereo(chunk([1], [0], [0]))
    expect(l?.[0]).toBeGreaterThan(0.5)
    expect(r?.[0]).toBe(0)
  })

  it('drops the LFE channel of a 5.1 layout', () => {
    const [l, r] = downmixToStereo(chunk([0], [0], [0], [1], [0], [0])) // L R C LFE SL SR with only the LFE active
    expect(l?.[0]).toBe(0)
    expect(r?.[0]).toBe(0)
  })

  it('sends the surrounds to their own side', () => {
    const [l, r] = downmixToStereo(chunk([0], [0], [0], [0], [1], [0])) // only SL
    expect(l?.[0]).toBeGreaterThan(0)
    expect(r?.[0]).toBe(0)
  })

  it('can never clip, even with every channel at full scale', () => {
    for (const channels of [3, 4, 5, 6, 7, 8]) {
      const [l, r] = downmixToStereo(Array.from({ length: channels }, () => Float32Array.of(1)))
      expect(Math.max(l?.[0] ?? 0, r?.[0] ?? 0)).toBeLessThanOrEqual(1 + 1e-6)
      expect(Math.max(l?.[0] ?? 0, r?.[0] ?? 0)).toBeGreaterThan(0.99) // ...and uses the full range (nothing is attenuated needlessly)
    }
  })

  it('averages channels alternately for layouts it does not know', () => {
    const [l, r] = downmixToStereo(Array.from({ length: 10 }, (_, i) => Float32Array.of(i % 2 === 0 ? 1 : -1)))
    expect(l?.[0]).toBeCloseTo(1, 6)
    expect(r?.[0]).toBeCloseTo(-1, 6)
  })
})

describe('wavHeader', () => {
  it('writes a canonical 16-bit PCM header', () => {
    const h = wavHeader(1000, 2, 48000)
    const v = new DataView(h.buffer)
    expect(String.fromCharCode(...h.slice(0, 4))).toBe('RIFF')
    expect(v.getUint32(4, true)).toBe(36 + 4000)
    expect(String.fromCharCode(...h.slice(8, 16))).toBe('WAVEfmt ')
    expect(v.getUint16(20, true)).toBe(1)
    expect(v.getUint16(22, true)).toBe(2)
    expect(v.getUint32(24, true)).toBe(48000)
    expect(v.getUint32(28, true)).toBe(48000 * 4)
    expect(v.getUint16(32, true)).toBe(4)
    expect(v.getUint16(34, true)).toBe(16)
    expect(String.fromCharCode(...h.slice(36, 40))).toBe('data')
    expect(v.getUint32(40, true)).toBe(4000)
  })

  it('refuses audio too long for a 32-bit RIFF size', () => {
    expect(() => wavHeader(2 ** 31, 2, 44100)).toThrow(RangeError)
  })
})

describe('AudioDecodeError', () => {
  it('carries a machine-readable code', () => {
    const e = new AudioDecodeError('nope', 'unsupported')
    expect(e).toBeInstanceOf(Error)
    expect(e.code).toBe('unsupported')
    expect(e.name).toBe('AudioDecodeError')
  })
})

describe('Pcm16Encoder', () => {
  it('quantizes with rounding and clips out-of-range values', async () => {
    const enc = new Pcm16Encoder({ channels: 1, sampleRate: 44100, dither: false })
    enc.push(chunk([0, 0.5, -0.5, 1, -1, 2, -2, 1 / 65536]))
    const { samples } = await readWav(enc.finish())
    expect([...samples]).toEqual([0, 16384, -16384, 32767, -32768, 32767, -32768, 1 / 65536 >= 0.5 / 32768 ? 1 : 0])
  })

  it('produces a valid header with the right sizes', async () => {
    const enc = new Pcm16Encoder({ channels: 2, sampleRate: 32000, dither: false })
    enc.push(chunk(new Array(100).fill(0.1), new Array(100).fill(-0.1)))
    const { bytes, view } = await readWav(enc.finish())
    expect(bytes.length).toBe(44 + 100 * 4)
    expect(view.getUint32(24, true)).toBe(32000)
    expect(view.getUint16(22, true)).toBe(2)
    expect(view.getUint32(40, true)).toBe(400)
    expect(enc.length).toBe(100)
  })

  it('interleaves the channels', async () => {
    const enc = new Pcm16Encoder({ channels: 2, sampleRate: 44100, dither: false })
    enc.push(chunk([0.25, 0.5], [-0.25, -0.5]))
    const { samples } = await readWav(enc.finish())
    expect([...samples]).toEqual([8192, -8192, 16384, -16384])
  })

  it('is independent of how the audio is split into chunks', async () => {
    const left = Array.from({ length: 5000 }, (_, i) => Math.sin(i / 20))
    const right = Array.from({ length: 5000 }, (_, i) => Math.cos(i / 33) * 0.7)
    const whole = new Pcm16Encoder({ channels: 2, sampleRate: 44100, dither: true, seed: 5 })
    whole.push(chunk(left, right))
    const pieces = new Pcm16Encoder({ channels: 2, sampleRate: 44100, dither: true, seed: 5 })
    for (let i = 0; i < 5000; i += 777) pieces.push(chunk(left.slice(i, i + 777), right.slice(i, i + 777)))
    expect([...(await readWav(pieces.finish())).samples]).toEqual([...(await readWav(whole.finish())).samples])
  })

  it('downmixes surround to stereo on the way in', async () => {
    const enc = new Pcm16Encoder({ channels: 6, sampleRate: 48000, dither: false })
    expect(enc.channels).toBe(2)
    enc.push(chunk([0.5], [0.5], [0], [0], [0], [0]))
    const { samples, view } = await readWav(enc.finish())
    expect(view.getUint16(22, true)).toBe(2)
    expect(samples).toHaveLength(2)
    expect(samples[0]).toBe(samples[1])
  })

  it('spans multiple internal pages correctly', async () => {
    const frames = 700_000 // 1.4 million samples: more than one 1M-sample page
    const ramp = new Float32Array(frames)
    for (let i = 0; i < frames; i++) ramp[i] = ((i % 20000) - 10000) / 10000
    const enc = new Pcm16Encoder({ channels: 2, sampleRate: 44100, dither: false })
    enc.push([ramp, ramp])
    const { bytes, samples } = await readWav(enc.finish())
    expect(bytes.length).toBe(44 + frames * 4)
    expect(samples[0]).toBe(Math.round(-1 * 32768))
    expect(samples[(frames - 1) * 2]).toBe(Math.min(32767, Math.round(ramp[frames - 1]! * 32768)))
    expect(samples[1_048_576]).toBe(Math.round(ramp[524_288]! * 32768)) // the first sample after the page boundary
  })

  describe('dither', () => {
    const silence = chunk(new Array(20000).fill(0))

    it('leaves silence silent without dither', async () => {
      const enc = new Pcm16Encoder({ channels: 1, sampleRate: 44100, dither: false })
      enc.push(silence)
      expect((await readWav(enc.finish())).samples.every((v) => v === 0)).toBe(true)
    })

    it('adds triangular noise of at most one LSB, centred on zero', async () => {
      const enc = new Pcm16Encoder({ channels: 1, sampleRate: 44100, dither: true })
      enc.push(silence)
      const { samples } = await readWav(enc.finish())
      const mean = samples.reduce((s, v) => s + v, 0) / samples.length
      expect(Math.max(...samples)).toBeLessThanOrEqual(1)
      expect(Math.min(...samples)).toBeGreaterThanOrEqual(-1)
      expect(samples.some((v) => v !== 0)).toBe(true)
      expect(Math.abs(mean)).toBeLessThan(0.05)
    })

    it('is reproducible for a seed and different for another', async () => {
      const make = async (seed: number) => {
        const enc = new Pcm16Encoder({ channels: 1, sampleRate: 44100, dither: true, seed })
        enc.push(silence)
        return [...(await readWav(enc.finish())).samples]
      }
      expect(await make(3)).toEqual(await make(3))
      expect(await make(3)).not.toEqual(await make(4))
    })
  })
})
