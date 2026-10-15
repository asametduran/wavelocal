import { describe, expect, it } from 'vitest'
import { decodeWav, encodeWav } from './wav'
import type { WavFormat } from './wav'

const ramp = (n: number, scale = 1): Float32Array => Float32Array.from({ length: n }, (_, i) => scale * (-1 + (2 * i) / (n - 1)))
const maxError = (a: Float32Array, b: Float32Array) => a.reduce((m, v, i) => Math.max(m, Math.abs(v - (b[i] ?? NaN))), 0)

describe('encodeWav', () => {
  it('writes a canonical 44-byte PCM16 header', () => {
    const bytes = encodeWav([new Float32Array(100)], { sampleRate: 44100 })
    const view = new DataView(bytes.buffer)
    const text = (o: number) => String.fromCharCode(...bytes.slice(o, o + 4))
    expect(text(0)).toBe('RIFF')
    expect(view.getUint32(4, true)).toBe(bytes.length - 8)
    expect(text(8)).toBe('WAVE')
    expect(text(12)).toBe('fmt ')
    expect(view.getUint16(20, true)).toBe(1) // PCM
    expect(view.getUint16(22, true)).toBe(1) // channels
    expect(view.getUint32(24, true)).toBe(44100)
    expect(view.getUint32(28, true)).toBe(88200) // byte rate
    expect(view.getUint16(32, true)).toBe(2) // block align
    expect(view.getUint16(34, true)).toBe(16)
    expect(text(36)).toBe('data')
    expect(view.getUint32(40, true)).toBe(200)
    expect(bytes.length).toBe(44 + 200)
  })

  it.each([
    ['pcm16', 1, 16, 2],
    ['pcm24', 1, 24, 3],
    ['float32', 3, 32, 4],
  ] as const)('%s uses format tag %i, %i bits, %i bytes per sample', (format, tag, bits, bytesPer) => {
    const bytes = encodeWav([new Float32Array(10), new Float32Array(10)], { format })
    const view = new DataView(bytes.buffer)
    expect(view.getUint16(20, true)).toBe(tag)
    expect(view.getUint16(34, true)).toBe(bits)
    expect(view.getUint16(32, true)).toBe(2 * bytesPer)
    expect(bytes.length).toBe(44 + 10 * 2 * bytesPer)
  })

  it('rejects empty, ragged and invalid-rate input', () => {
    expect(() => encodeWav([])).toThrow(RangeError)
    expect(() => encodeWav([new Float32Array(3), new Float32Array(4)])).toThrow(/equal length/)
    expect(() => encodeWav([new Float32Array(3)], { sampleRate: 0 })).toThrow(RangeError)
    expect(() => encodeWav([new Float32Array(3)], { sampleRate: 44100.5 })).toThrow(RangeError)
  })

  it('clips out-of-range samples instead of wrapping', () => {
    const decoded = decodeWav(encodeWav([Float32Array.of(2, -2, 1, -1)]))
    expect([...decoded.channels[0]!]).toEqual([32767 / 32768, -1, 32767 / 32768, -1])
  })

  it('produces an empty data chunk for zero-length audio', () => {
    const decoded = decodeWav(encodeWav([new Float32Array(0)]))
    expect(decoded.channels[0]?.length).toBe(0)
  })
})

describe('decodeWav round trip', () => {
  const tolerance: Record<WavFormat, number> = { pcm16: 1 / 32768, pcm24: 1 / 8388608, float32: 0 }

  it.each(['pcm16', 'pcm24', 'float32'] as const)('%s is lossless within quantization error', (format) => {
    const input = ramp(1001, 0.999)
    const decoded = decodeWav(encodeWav([input], { format, sampleRate: 22050 }))
    expect(decoded.format).toBe(format)
    expect(decoded.sampleRate).toBe(22050)
    expect(decoded.channels).toHaveLength(1)
    expect(maxError(decoded.channels[0]!, input)).toBeLessThanOrEqual(tolerance[format] + 1e-9)
  })

  it('handles negative 24-bit values (sign extension)', () => {
    const decoded = decodeWav(encodeWav([Float32Array.of(-0.25, -0.999, 0.25)], { format: 'pcm24' }))
    expect(decoded.channels[0]![0]).toBeCloseTo(-0.25, 6)
    expect(decoded.channels[0]![1]).toBeCloseTo(-0.999, 6)
    expect(decoded.channels[0]![2]).toBeCloseTo(0.25, 6)
  })

  it('keeps stereo channels separate and in order', () => {
    const left = Float32Array.of(0.5, 0.5, 0.5)
    const right = Float32Array.of(-0.25, -0.25, -0.25)
    const decoded = decodeWav(encodeWav([left, right], { format: 'float32' }))
    expect(decoded.channels).toHaveLength(2)
    expect([...decoded.channels[0]!]).toEqual([0.5, 0.5, 0.5])
    expect([...decoded.channels[1]!]).toEqual([-0.25, -0.25, -0.25])
  })

  it('skips unknown chunks, including odd-sized ones that need padding', () => {
    const wav = encodeWav([Float32Array.of(0.5, -0.5)], { format: 'float32' })
    const list = Uint8Array.from([...'LIST'].map((c) => c.charCodeAt(0)).concat([3, 0, 0, 0, 1, 2, 3, 0]))
    const withList = new Uint8Array(wav.length + list.length)
    withList.set(wav.subarray(0, 36), 0) // RIFF header + fmt chunk
    withList.set(list, 36)
    withList.set(wav.subarray(36), 36 + list.length) // data chunk
    const decoded = decodeWav(withList)
    expect([...decoded.channels[0]!]).toEqual([0.5, -0.5])
  })

  it('tolerates a data chunk that claims more bytes than the file holds', () => {
    const wav = encodeWav([Float32Array.of(0.1, 0.2, 0.3, 0.4)])
    const truncated = wav.slice(0, wav.length - 1) // cut mid-sample
    expect(decodeWav(truncated).channels[0]).toHaveLength(3)
  })
})

describe('decodeWav errors', () => {
  it('rejects non-WAV data', () => {
    expect(() => decodeWav(new Uint8Array(64))).toThrow(/RIFF/)
    expect(() => decodeWav(new Uint8Array(4))).toThrow(/RIFF/)
  })

  it('rejects a file with no data chunk', () => {
    const wav = encodeWav([new Float32Array(4)])
    expect(() => decodeWav(wav.subarray(0, 36))).toThrow(/data chunk/)
  })

  it('rejects a file with no fmt chunk', () => {
    const wav = encodeWav([new Float32Array(4)]).slice()
    wav.set([...'junk'].map((c) => c.charCodeAt(0)), 12) // rename the fmt chunk
    expect(() => decodeWav(wav)).toThrow(/fmt chunk/)
  })

  it('rejects unsupported encodings', () => {
    const wav = encodeWav([new Float32Array(4)]).slice()
    new DataView(wav.buffer).setUint16(20, 0x55, true) // MPEG-in-WAV
    expect(() => decodeWav(wav)).toThrow(/Unsupported/)
  })
})
