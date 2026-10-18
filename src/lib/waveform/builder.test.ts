// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { PEAK_BUCKETS, PeakBuilder, level } from './builder'
import { timed } from '../../test-utils/fuzz'

const RATE = 8000
/** A 1 kHz sine at 8 kHz repeats every 8 frames and reaches exactly +-amplitude, so its peak and its RMS (amplitude over root two) are known. */
const sine = (frames: number, amplitude: number, from = 0): Float32Array =>
  Float32Array.from({ length: frames }, (_, i) => amplitude * Math.sin((2 * Math.PI * (from + i)) / 8))
const zeros = (frames: number): Float32Array => new Float32Array(frames)
const filled = (frames: number, value: number): Float32Array => new Float32Array(frames).fill(value)

// The expected numbers below are worked out by hand from the dB scale (level = 1 + dB / 50, times 255, rounded):
// 0.8 is -1.94 dB -> 245, 0.8 / root 2 is -4.95 dB -> 230, 0.4 is -7.96 dB -> 214, 0.4 / root 2 is -10.97 dB -> 199.

describe('level', () => {
  it('puts full scale at 255 and anything at or below -50 dBFS at 0, so quiet detail is visible but silence is flat', () => {
    expect(level(1)).toBe(255)
    expect(level(2)).toBe(255)
    expect(level(0)).toBe(0)
    expect(level(10 ** (-50 / 20))).toBe(0)
    expect(level(1e-9)).toBe(0)
  })

  it('is linear in decibels: half the amplitude is 6 dB lower, a tenth is 20 dB lower', () => {
    expect(level(0.5)).toBe(224)
    expect(level(0.1)).toBe(153)
    expect(level(10 ** (-25 / 20))).toBe(128)
    expect(level(10 ** (-49 / 20))).toBe(5)
  })

  it('reads a negative or missing value as silence rather than as a sound', () => {
    expect(level(-0.5)).toBe(0)
    expect(level(Number.NaN)).toBe(0)
  })
})

describe('PeakBuilder', () => {
  it('reads a steady tone: the peak is the amplitude and the RMS is the amplitude over root two', () => {
    const builder = new PeakBuilder(RATE)
    builder.push([sine(RATE * 2, 0.8)])
    const peaks = builder.finish(4)
    expect(peaks).not.toBeNull()
    expect(peaks).toMatchObject({ v: 1, length: 4, duration: 2 })
    expect([...(peaks?.peak ?? [])]).toEqual([245, 245, 245, 245])
    expect([...(peaks?.rms ?? [])]).toEqual([230, 230, 230, 230])
  })

  it('shows a gap as flat and a quieter passage as lower, bucket by bucket', () => {
    const builder = new PeakBuilder(RATE)
    builder.push([sine(RATE * 3, 0.8)])
    builder.push([zeros(RATE * 2)])
    builder.push([sine(RATE * 3, 0.4)])
    const peaks = builder.finish(8)
    expect([...(peaks?.peak ?? [])]).toEqual([245, 245, 245, 0, 0, 214, 214, 214])
    expect([...(peaks?.rms ?? [])]).toEqual([230, 230, 230, 0, 0, 199, 199, 199])
  })

  it('gives every bucket exactly the windows that fall in it when the count does not divide evenly', () => {
    // 10 windows of 200 frames cut into 3 buckets: windows 0-2, 3-5 and 6-9. A single loud frame in window 6 is in the last one only.
    const builder = new PeakBuilder(RATE)
    const audio = zeros(2000)
    audio[1250] = 1
    builder.push([audio])
    const peaks = builder.finish(3)
    expect(peaks?.length).toBe(3)
    expect([...(peaks?.peak ?? [])]).toEqual([0, 0, 255])
    // that frame is 1 of the 800 frames of the last bucket: RMS = sqrt(1 / 800), -29 dB
    expect([...(peaks?.rms ?? [])]).toEqual([0, 0, 107])
  })

  it('weighs a shorter last window by its real length, not as a whole one', () => {
    // 200 frames at 1.0 and 50 at 0.5: mean square (200 + 50 * 0.25) / 250 = 0.85
    const builder = new PeakBuilder(RATE)
    builder.push([filled(200, 1)])
    builder.push([filled(50, 0.5)])
    const peaks = builder.finish(1)
    expect(peaks?.peak[0]).toBe(255)
    expect(peaks?.rms[0]).toBe(251)
  })

  it('takes the loudest channel for the peak and every channel for the RMS', () => {
    // left at full scale, right silent: the peak is full scale, the power is half of it (-3 dB)
    const builder = new PeakBuilder(RATE)
    builder.push([filled(1600, 1), zeros(1600)])
    const peaks = builder.finish(1)
    expect(peaks?.peak[0]).toBe(255)
    expect(peaks?.rms[0]).toBe(240)
  })

  it('gives the same result however the audio is cut into chunks', () => {
    const audio = new Float32Array(20_000)
    audio.set(sine(7000, 0.7), 0)
    audio.set(sine(5000, 0.2), 9000)
    const whole = new PeakBuilder(RATE)
    whole.push([audio])
    const expected = whole.finish(37)
    for (const size of [1, 7, 199, 200, 201, 4999, 20_000]) {
      const cut = new PeakBuilder(RATE)
      for (let at = 0; at < audio.length; at += size) cut.push([audio.subarray(at, at + size)])
      expect(cut.finish(37), `chunks of ${size}`).toEqual(expected)
    }
  })

  it('has nothing to say about no audio at all', () => {
    const builder = new PeakBuilder(RATE)
    expect(builder.finish()).toBeNull()
    builder.push([])
    builder.push([new Float32Array(0)])
    expect(builder.frames).toBe(0)
    expect(builder.finish()).toBeNull()
  })

  it('reads samples that are not numbers as silence and caps overs at full scale', () => {
    // a rate of 200 gives windows of 5 frames: [NaN, +inf, -inf, 2, -2] is read as [0, 0, 0, 1, 1]
    const builder = new PeakBuilder(200)
    builder.push([Float32Array.from([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 2, -2])])
    const peaks = builder.finish(1)
    expect(peaks?.peak[0]).toBe(255)
    expect(peaks?.rms[0]).toBe(235)
  })

  it('uses the shortest channel when they disagree, instead of reading past the end of one', () => {
    const builder = new PeakBuilder(RATE)
    builder.push([filled(400, 0.5), filled(250, 0.5)])
    expect(builder.frames).toBe(250)
  })

  it('counts a stretch it was told to skip as silence, and keeps everything after it in time', () => {
    const builder = new PeakBuilder(RATE)
    builder.push([sine(RATE, 0.8)])
    builder.skip(RATE)
    builder.push([sine(RATE, 0.8)])
    const peaks = builder.finish(3)
    expect(peaks?.duration).toBe(3)
    expect([...(peaks?.peak ?? [])]).toEqual([245, 0, 245])
  })

  it('reports the duration of the frames it was given', () => {
    const builder = new PeakBuilder(RATE)
    builder.push([zeros(12_000)])
    expect(builder.duration).toBe(1.5)
  })

  it('makes fewer slices than asked for when there is less audio than that', () => {
    const builder = new PeakBuilder(RATE)
    builder.push([sine(1000, 0.8)]) // 5 windows
    expect(builder.finish(1024)?.length).toBe(5)
  })

  it('fills the whole default number of slices for a long track', () => {
    const builder = new PeakBuilder(RATE)
    builder.push([sine(RATE * 60, 0.5)])
    expect(builder.finish()?.length).toBe(PEAK_BUCKETS)
  })

  it('keeps its memory to the windows, not the audio, and grows past its first allocation: two hours', () => {
    const hour = filled(RATE * 72, 0.1) // 72 s, pushed 100 times
    const builder = new PeakBuilder(RATE)
    const { result, ms } = timed(() => {
      for (let i = 0; i < 100; i++) builder.push([hour])
      return builder.finish()
    })
    expect(result?.duration).toBe(7200)
    expect(result?.length).toBe(PEAK_BUCKETS)
    expect(new Set(result?.peak)).toEqual(new Set([153]))
    expect(new Set(result?.rms)).toEqual(new Set([153]))
    // Only work that grows faster than the audio should fail this (it takes minutes then). The CPU clock counts every thread, and the
    // parallel garbage collection of a run under coverage made a four-core CI runner read 5.1 s here, against 0.7 s on a laptop.
    expect(ms).toBeLessThan(12_000)
  })

  it('refuses a sample rate that is not a positive number', () => {
    expect(() => new PeakBuilder(0)).toThrow(RangeError)
    expect(() => new PeakBuilder(Number.NaN)).toThrow(RangeError)
    expect(() => new PeakBuilder(-44100)).toThrow(RangeError)
  })
})
