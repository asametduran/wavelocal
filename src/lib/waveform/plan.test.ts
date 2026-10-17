// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { LOSSLESS_LIMIT_BYTES, planPeaks, planWindows } from './plan'
import type { PlanInput } from './plan'

const MiB = 1024 * 1024
const input = (change: Partial<PlanInput>): PlanInput => ({ container: 'mp4', size: 5 * MiB, duration: 200, sampleRate: 44100, channels: 2, ...change })

describe('planPeaks', () => {
  it('reads WAV and FLAC with the built-in decoders, in a worker, however long they are', () => {
    expect(planPeaks(input({ container: 'wav', size: 40 * MiB, duration: 240 }))).toEqual({ method: 'lossless' })
    expect(planPeaks(input({ container: 'flac', size: 300 * MiB, duration: 3600 }))).toEqual({ method: 'lossless' })
  })

  it('does not read a WAV or FLAC file too big for the worker to hold', () => {
    expect(planPeaks(input({ container: 'wav', size: LOSSLESS_LIMIT_BYTES }))).toEqual({ method: 'lossless' })
    expect(planPeaks(input({ container: 'wav', size: LOSSLESS_LIMIT_BYTES + 1 }))).toEqual({ method: 'none', why: 'too-long' })
    expect(planPeaks(input({ container: 'flac', size: 2048 * MiB }))).toEqual({ method: 'none', why: 'too-long' })
  })

  it('cuts MP3 and ADTS AAC into windows, however long they are, since the decoder finds the next frame by itself', () => {
    expect(planPeaks(input({ container: 'mp3', size: 400 * MiB, duration: 40_000 }))).toEqual({ method: 'sliced' })
    expect(planPeaks(input({ container: 'aac', size: 30 * MiB, duration: 3000 }))).toEqual({ method: 'sliced' })
    expect(planPeaks(input({ container: 'mp3', size: 3 * MiB, duration: 0 }))).toEqual({ method: 'sliced' })
  })

  it('decodes other containers whole while the decoded audio fits in memory', () => {
    // stereo 44.1 kHz floats are 352,800 bytes a second: 200 MiB lasts 594.4 s
    expect(planPeaks(input({ container: 'mp4', duration: 594 }))).toEqual({ method: 'whole' })
    expect(planPeaks(input({ container: 'mp4', duration: 595 }))).toEqual({ method: 'none', why: 'too-long' })
    expect(planPeaks(input({ container: 'ogg', duration: 240 }))).toEqual({ method: 'whole' })
  })

  it('counts every channel and the real sample rate when it weighs the decoded audio', () => {
    // mono at 22,050 Hz is 88,200 bytes a second: 200 MiB lasts 2,377.7 s
    expect(planPeaks(input({ container: 'mp4', duration: 2377, sampleRate: 22050, channels: 1 }))).toEqual({ method: 'whole' })
    expect(planPeaks(input({ container: 'mp4', duration: 2378, sampleRate: 22050, channels: 1 }))).toEqual({ method: 'none', why: 'too-long' })
    // six channels at 48 kHz are 1,152,000 bytes a second: 200 MiB lasts 182.04 s
    expect(planPeaks(input({ container: 'ogg', duration: 182, sampleRate: 48000, channels: 6 }))).toEqual({ method: 'whole' })
    expect(planPeaks(input({ container: 'ogg', duration: 183, sampleRate: 48000, channels: 6 }))).toEqual({ method: 'none', why: 'too-long' })
  })

  it('assumes stereo at 48 kHz for a file whose format is not known', () => {
    // 384,000 bytes a second: 200 MiB lasts 546.1 s
    expect(planPeaks(input({ container: 'mp4', duration: 546, sampleRate: 0, channels: 0 }))).toEqual({ method: 'whole' })
    expect(planPeaks(input({ container: 'mp4', duration: 547, sampleRate: 0, channels: 0 }))).toEqual({ method: 'none', why: 'too-long' })
  })

  it('tries a file whose length is not known only when it is small, since the length would be a guess', () => {
    expect(planPeaks(input({ container: null, duration: 0, size: 6 * MiB }))).toEqual({ method: 'whole' })
    expect(planPeaks(input({ container: null, duration: 0, size: 60 * MiB }))).toEqual({ method: 'none', why: 'too-long' })
    expect(planPeaks(input({ container: 'ogg', duration: 0, size: 60 * MiB }))).toEqual({ method: 'none', why: 'too-long' })
  })
})

describe('planWindows', () => {
  const contiguous = (windows: { start: number; end: number }[], from: number, to: number) => {
    expect(windows[0]?.start).toBe(from)
    expect(windows.at(-1)?.end).toBe(to)
    windows.slice(1).forEach((window, i) => expect(window.start).toBe(windows[i]?.end))
  }

  it('is one window, all the audio after the tag, for a song a single decode can hold', () => {
    // a 4 minute song with a 20 kB tag in front
    expect(planWindows(3_860_000, 20_000, 240)).toEqual([{ start: 20_000, end: 3_860_000 }])
  })

  it('cuts a longer file into windows of about 90 s that follow each other exactly and cover everything after the tag', () => {
    // 10 minutes at 128 kbit/s: 16,000 bytes a second, 1,440,000 bytes per 90 s window, so 9,600,000 bytes take 7 windows
    const windows = planWindows(9_620_000, 20_000, 600)
    expect(windows).toHaveLength(7)
    contiguous(windows, 20_000, 9_620_000)
  })

  it('spreads the audio evenly, so the last window is not a sliver the decoder could not read', () => {
    const sizes = planWindows(9_620_000, 20_000, 600).map((w) => w.end - w.start)
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1)
  })

  it('guesses 128 kbit/s when the length is not known, and then never makes it one window', () => {
    // 4,800,000 bytes at 16,000 a second are 300 s: 4,800,000 / 1,440,000 = 3.3 -> 4 windows
    const windows = planWindows(4_800_000, 0, 0)
    expect(windows).toHaveLength(4)
    contiguous(windows, 0, 4_800_000)
  })

  it('does not make a window of a very low bit rate smaller than 64 KiB', () => {
    // 2 MiB that claim to last 200,000 s: 10 bytes a second would give 900-byte windows; 64 KiB gives exactly 32
    const windows = planWindows(2 * MiB, 0, 200_000)
    expect(windows).toHaveLength(32)
    contiguous(windows, 0, 2 * MiB)
  })

  it('does not make a window larger than 24 MiB, even when the length in the header is nonsense', () => {
    // 300 MiB that claim to last 2 minutes: 13 windows of about 23 MiB
    const windows = planWindows(300 * MiB, 0, 120)
    expect(windows).toHaveLength(13)
    expect(Math.max(...windows.map((w) => w.end - w.start))).toBeLessThanOrEqual(24 * MiB)
    contiguous(windows, 0, 300 * MiB)
  })

  it('stops at a thousand windows by making them bigger, so a huge file is not a thousand more decode calls', () => {
    // 100 MiB over 64 KiB windows would be 1,600
    const windows = planWindows(100 * MiB, 0, 10_000_000)
    expect(windows).toHaveLength(1000)
    contiguous(windows, 0, 100 * MiB)
  })

  it('has nothing to decode in a file that is all tag, empty or not a number', () => {
    expect(planWindows(1000, 1000, 10)).toEqual([])
    expect(planWindows(1000, 5000, 10)).toEqual([])
    expect(planWindows(0, 0, 0)).toEqual([])
    expect(planWindows(Number.NaN, 0, 10)).toEqual([])
  })
})
