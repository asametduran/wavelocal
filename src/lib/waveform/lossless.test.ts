// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { peaksFromLossless } from './lossless'
import { AudioDecodeError } from '../audio/pcm'
import { concat, silence, sine } from '../../test-utils/signals'
import { encodeWav } from '../../test-utils/wav'
import { encodeFlac, floatToInt } from '../../test-utils/flac-encoder'

const RATE = 8000
/** 1 kHz at 8 kHz repeats every 8 frames and reaches exactly +-amplitude, so peak and RMS (amplitude over root two) are known. */
const tone = (seconds: number, amplitude: number): Float32Array => sine({ frequency: 1000, amplitude, seconds, sampleRate: RATE })
/** 2 s loud (0.5), 1 s silent, 2 s quiet (0.25): five one-second slices. */
const song = (): Float32Array => concat(tone(2, 0.5), silence({ seconds: 1, sampleRate: RATE }), tone(2, 0.25))

// Worked out by hand from the dB scale: 0.5 is -6.02 dB -> 224 and its RMS -9.03 dB -> 209; 0.25 is -12.04 dB -> 194 and -15.05 dB -> 178.
const PEAK = [224, 224, 0, 194, 194]
const RMS = [209, 209, 0, 178, 178]

const wav = (channels: Float32Array[], format: 'pcm16' | 'pcm24' | 'float32' = 'pcm16') => encodeWav(channels, { sampleRate: RATE, format })
const flac = (channels: Float32Array[], bits = 16) => encodeFlac(channels.map((c) => floatToInt(c, bits)), { sampleRate: RATE, bitsPerSample: bits })

describe('peaksFromLossless', () => {
  it('follows the loud, silent and quiet parts of a WAV file', async () => {
    const peaks = await peaksFromLossless(wav([song()]), { buckets: 5 })
    expect(peaks).toMatchObject({ v: 1, length: 5, duration: 5 })
    expect([...peaks.peak]).toEqual(PEAK)
    expect([...peaks.rms]).toEqual(RMS)
  })

  it('reads 24-bit and 32-bit float WAV files the same way', async () => {
    for (const format of ['pcm24', 'float32'] as const) {
      const peaks = await peaksFromLossless(wav([song()], format), { buckets: 5 })
      expect([...peaks.peak], format).toEqual(PEAK)
      expect([...peaks.rms], format).toEqual(RMS)
    }
  })

  it('gives a FLAC file the peaks of the same audio in a WAV file: lossless is lossless', async () => {
    const fromWav = await peaksFromLossless(wav([song()]))
    const fromFlac = await peaksFromLossless(flac([song()]))
    expect(fromFlac).toEqual(fromWav)
    expect([...(await peaksFromLossless(flac([song()]), { buckets: 5 })).peak]).toEqual(PEAK)
  })

  it('takes the louder channel of a stereo file for the peak and averages the power of both for the RMS', async () => {
    // left at 0.5, right silent: the peak is the left's 0.5, the power is half the left's (0.125 / 2), so the RMS is exactly 0.25
    const peaks = await peaksFromLossless(wav([tone(2, 0.5), silence({ seconds: 2, sampleRate: RATE })]), { buckets: 2 })
    expect([...peaks.peak]).toEqual([224, 224])
    expect([...peaks.rms]).toEqual([194, 194])
  })

  it('accepts a Blob as well as bytes, the way a stored file arrives', async () => {
    const bytes = wav([song()])
    const fromBlob = await peaksFromLossless(new Blob([bytes], { type: 'audio/wav' }), { buckets: 5 })
    expect([...fromBlob.peak]).toEqual(PEAK)
  })

  it('reports progress that only goes forward and ends at one', async () => {
    const seen: number[] = []
    await peaksFromLossless(wav([concat(tone(10, 0.5), tone(10, 0.5))]), { onProgress: (fraction) => seen.push(fraction) })
    expect(seen.length).toBeGreaterThan(1)
    expect(seen.at(-1)).toBe(1)
    seen.slice(1).forEach((fraction, i) => expect(fraction).toBeGreaterThanOrEqual(seen[i] ?? 0))
  })

  it('stops with an "aborted" error when it is cancelled before it starts', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(peaksFromLossless(wav([song()]), { signal: controller.signal })).rejects.toMatchObject({ name: 'AudioDecodeError', code: 'aborted' })
  })

  it('stops with an "aborted" error when it is cancelled half way, instead of finishing the whole file', async () => {
    const controller = new AbortController()
    let chunks = 0
    const run = peaksFromLossless(wav([concat(tone(10, 0.5), tone(10, 0.5))]), {
      signal: controller.signal,
      onProgress: () => {
        if (++chunks === 2) controller.abort()
      },
    })
    await expect(run).rejects.toBeInstanceOf(AudioDecodeError)
    await expect(run).rejects.toMatchObject({ code: 'aborted' })
    expect(chunks).toBeLessThan(10)
  })

  it('says "unsupported" for a file that is neither WAV nor FLAC, and "corrupt" for one with no audio in it', async () => {
    await expect(peaksFromLossless(new Uint8Array(100).fill(7))).rejects.toMatchObject({ code: 'unsupported' })
    await expect(peaksFromLossless(wav([new Float32Array(0)]))).rejects.toMatchObject({ code: 'corrupt' })
  })
})
