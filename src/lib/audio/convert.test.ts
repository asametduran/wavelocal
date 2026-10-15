import { describe, expect, it } from 'vitest'
import { seededRandom } from '../dsp'
import { encodeFlac } from '../../test-utils/flac-encoder'
import { encodeWav } from '../../test-utils/wav'
import { convertToWav, firstChannelChunks } from './convert'
import { AudioDecodeError } from './pcm'
import { parseWav, readWavFrames } from './wav'

const tone = (length: number, bits: number, seed = 1) => {
  const rand = seededRandom(seed)
  const peak = 2 ** (bits - 1) - 1
  return Int32Array.from({ length }, (_, i) => Math.round(peak * (0.6 * Math.sin(i / 11) + 0.2 * Math.sin(i / 3) + 0.02 * (rand() - 0.5))))
}

const flacOf = (channels: Int32Array[], bits = 16, rate = 44100, extra = {}) => encodeFlac(channels, { sampleRate: rate, bitsPerSample: bits, blockSize: 1024, ...extra })

/** Parse a converted blob back into integer samples per channel. */
async function readBack(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const info = parseWav(bytes)
  const pcm = readWavFrames(bytes, info, 0, info.frames)
  return { info, ints: pcm.map((c) => Int32Array.from(c, (v) => Math.round(v * 32768))) }
}

describe('convertToWav: FLAC', () => {
  it('reproduces 16-bit audio sample for sample', async () => {
    const left = tone(7000, 16, 1)
    const right = tone(7000, 16, 2)
    const result = await convertToWav(flacOf([left, right]))
    expect(result).toMatchObject({ container: 'flac', sampleRate: 44100, channels: 2, sourceChannels: 2, sourceBitsPerSample: 16, frames: 7000 })
    expect(result.duration).toBeCloseTo(7000 / 44100, 10)
    const { info, ints } = await readBack(result.blob)
    expect(info).toMatchObject({ channels: 2, sampleRate: 44100, bitsPerSample: 16, frames: 7000 })
    expect(ints[0]?.every((v, i) => v === left[i])).toBe(true)
    expect(ints[1]?.every((v, i) => v === right[i])).toBe(true)
    expect(result.blob.type).toBe('audio/wav')
  })

  it('reduces 24-bit audio to 16 bits with dither: within one LSB of the true value, without bias', async () => {
    const source = tone(20000, 24)
    const { ints } = await readBack((await convertToWav(flacOf([source], 24))).blob)
    let sum = 0
    let worst = 0
    ints[0]?.forEach((v, i) => {
      const exact = (source[i] ?? 0) / 256
      const error = v - exact
      sum += error
      worst = Math.max(worst, Math.abs(error))
    })
    expect(worst).toBeLessThanOrEqual(1.5) // rounding (0.5) plus triangular dither (up to 1)
    expect(Math.abs(sum / 20000)).toBeLessThan(0.05)
  })

  it('does not dither 16-bit sources (they are exact)', async () => {
    const quiet = Int32Array.from({ length: 4000 }, (_, i) => (i % 7) - 3)
    const { ints } = await readBack((await convertToWav(flacOf([quiet]))).blob)
    expect(ints[0]?.every((v, i) => v === quiet[i])).toBe(true)
  })

  it('keeps mono mono and keeps the sample rate', async () => {
    const result = await convertToWav(flacOf([tone(3000, 16)], 16, 22050))
    expect(result).toMatchObject({ channels: 1, sampleRate: 22050 })
    expect((await readBack(result.blob)).info).toMatchObject({ channels: 1, sampleRate: 22050 })
  })

  it('folds a 5.1 stream down to stereo', async () => {
    const six = Array.from({ length: 6 }, (_, c) => tone(2000, 16, c + 1))
    const result = await convertToWav(flacOf(six))
    expect(result).toMatchObject({ channels: 2, sourceChannels: 6 })
    expect((await readBack(result.blob)).info.channels).toBe(2)
  })

  it('reports damaged frames as warnings and still produces audio of the right length', async () => {
    const good = flacOf([tone(8192, 16)], 16, 44100, { blockSize: 2048, subframe: 'verbatim' })
    const bad = good.slice()
    bad[bad.length - 3000] = (bad[bad.length - 3000] ?? 0) ^ 0x40
    const result = await convertToWav(bad)
    expect(result.frames).toBe(8192)
    expect(result.warnings.join()).toMatch(/Concealed/)
  })

  it('fails on damage when lenient mode is off', async () => {
    const bad = flacOf([tone(8192, 16)], 16, 44100, { blockSize: 2048, subframe: 'verbatim' })
    bad[bad.length - 3000] = (bad[bad.length - 3000] ?? 0) ^ 0x40
    await expect(convertToWav(bad, { lenient: false })).rejects.toBeInstanceOf(AudioDecodeError)
  })

  it('can verify the stored MD5', async () => {
    const result = await convertToWav(flacOf([tone(5000, 16)]), { verifyMd5: true })
    expect(result.warnings).toEqual([])
  })
})

describe('convertToWav: WAV', () => {
  it('converts 32-bit float to 16-bit PCM', async () => {
    const source = Float32Array.from({ length: 3000 }, (_, i) => Math.sin(i / 9) * 0.4)
    const result = await convertToWav(encodeWav([source], { format: 'float32', sampleRate: 48000 }))
    expect(result).toMatchObject({ container: 'wav', sampleRate: 48000, channels: 1, sourceBitsPerSample: 32 })
    const { ints } = await readBack(result.blob)
    ints[0]?.forEach((v, i) => expect(Math.abs(v - (source[i] ?? 0) * 32768)).toBeLessThanOrEqual(1.5))
  })

  it('converts 24-bit PCM, and 16-bit PCM exactly', async () => {
    const source = Float32Array.from({ length: 2000 }, (_, i) => Math.sin(i / 7) * 0.5)
    const twelve = await convertToWav(encodeWav([source], { format: 'pcm16' }))
    const { ints } = await readBack(twelve.blob)
    ints[0]?.forEach((v, i) => expect(v).toBe(Math.round(Math.max(-1, Math.min(32767 / 32768, source[i] ?? 0)) * 32768)))
    const result = await convertToWav(encodeWav([source], { format: 'pcm24' }))
    expect(result.sourceBitsPerSample).toBe(24)
  })

  it('folds stereo float down correctly and keeps both channels', async () => {
    const l = Float32Array.from({ length: 500 }, () => 0.5)
    const r = Float32Array.from({ length: 500 }, () => -0.25)
    const { ints } = await readBack((await convertToWav(encodeWav([l, r], { format: 'float32' }))).blob)
    // float sources are dithered when reduced to 16 bits, so allow the +-1 LSB of that noise
    expect(Math.abs((ints[0]?.[10] ?? 0) - 16384)).toBeLessThanOrEqual(1)
    expect(Math.abs((ints[1]?.[10] ?? 0) + 8192)).toBeLessThanOrEqual(1)
  })

  it('accepts raw bytes as well as Blobs', async () => {
    const bytes = encodeWav([new Float32Array(100)], { format: 'pcm16' })
    expect((await convertToWav(bytes)).frames).toBe(100)
    expect((await convertToWav(new Blob([bytes]))).frames).toBe(100)
  })
})

describe('convertToWav: control', () => {
  const source = flacOf([tone(60000, 16)], 16, 44100, { blockSize: 1024 })

  it('reports monotonic progress ending at 1', async () => {
    const seen: number[] = []
    await convertToWav(source, { onProgress: (f) => seen.push(f) })
    expect(seen.length).toBeGreaterThan(5)
    expect(seen.every((f, i) => i === 0 || f >= (seen[i - 1] ?? 0))).toBe(true)
    expect(seen[seen.length - 1]).toBe(1)
  })

  it('still finishes with progress 1 when the stream length is unknown', async () => {
    const seen: number[] = []
    await convertToWav(flacOf([tone(5000, 16)], 16, 44100, { writeTotalSamples: false }), { onProgress: (f) => seen.push(f) })
    expect(seen[seen.length - 1]).toBe(1)
  })

  it('can be cancelled part way', async () => {
    const controller = new AbortController()
    const run = convertToWav(source, {
      signal: controller.signal,
      onProgress: (f) => {
        if (f > 0.2) controller.abort()
      },
    })
    await expect(run).rejects.toMatchObject({ code: 'aborted' })
  })

  it('refuses to start when already cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(convertToWav(source, { signal: controller.signal })).rejects.toMatchObject({ code: 'aborted' })
  })

  it('keeps the event loop alive by yielding while it works', async () => {
    let ticks = 0
    const timer = setInterval(() => ticks++, 1)
    await convertToWav(source, { yieldEveryMs: 1 })
    clearInterval(timer)
    expect(ticks).toBeGreaterThan(0)
  })

  it('rejects data that is neither WAV nor FLAC', async () => {
    await expect(convertToWav(new Uint8Array(500))).rejects.toMatchObject({ code: 'unsupported' })
  })

  it('surfaces typed errors for unsupported WAV encodings', async () => {
    const bad = encodeWav([new Float32Array(10)], { format: 'pcm16' }).slice()
    new DataView(bad.buffer).setUint16(20, 0x11, true)
    await expect(convertToWav(bad)).rejects.toMatchObject({ code: 'unsupported' })
  })
})

describe('firstChannelChunks', () => {
  it('streams the first channel of FLAC and WAV as floats', () => {
    const data = tone(3000, 16)
    const fromFlac = [...firstChannelChunks(flacOf([data, data]))]
    expect(fromFlac.reduce((n, c) => n + c.length, 0)).toBe(3000)
    expect(fromFlac[0]?.[50]).toBe((data[50] ?? 0) / 32768)

    const wav = encodeWav([Float32Array.from({ length: 100 }, () => 0.25)], { format: 'float32' })
    expect([...firstChannelChunks(wav)].flatMap((c) => [...c])).toEqual(new Array(100).fill(0.25))
  })

  it('throws for other data', () => {
    expect(() => [...firstChannelChunks(new Uint8Array(100))]).toThrow(/Not a WAV or FLAC/)
  })
})
