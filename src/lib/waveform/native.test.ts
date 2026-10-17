// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { DECODE_RATE, browserDecode, peaksFromWhole, peaksFromWindows } from './native'
import type { DecodeFn } from './native'
import type { ByteWindow } from './plan'
import { concat, silence, sine } from '../../test-utils/signals'

const RATE = 8000
const tone = (seconds: number, amplitude: number): Float32Array => sine({ frequency: 1000, amplitude, seconds, sampleRate: RATE })
/** 2 s loud (0.5), 1 s silent, 2 s quiet (0.25), then 1 s loud again: six one-second slices. */
const song = (): Float32Array => concat(tone(2, 0.5), silence({ seconds: 1, sampleRate: RATE }), tone(2, 0.25), tone(1, 0.5))
const PEAK = [224, 224, 0, 194, 194, 224]

/** The "codec" of these tests: a file is raw 32-bit floats, one channel, which `decode` hands back as they are. */
const file = (samples: Float32Array): Blob => new Blob([samples.buffer as ArrayBuffer])
const decodeFloats: DecodeFn = async (data) => ({ sampleRate: RATE, channels: [new Float32Array(data)] })
/** Windows of `frames` frames each (4 bytes a frame), the last one taking what is left. */
const windowsOf = (total: number, frames: number): ByteWindow[] =>
  Array.from({ length: Math.ceil(total / frames) }, (_, i) => ({ start: i * frames * 4, end: Math.min(total, (i + 1) * frames) * 4 }))

const options = { sampleRate: RATE, buckets: 6, duration: 6 }

describe('peaksFromWhole', () => {
  it('measures what the decoder returns', async () => {
    const peaks = await peaksFromWhole(file(song()), decodeFloats, options)
    expect(peaks).toMatchObject({ v: 1, length: 6, duration: 6 })
    expect([...peaks.peak]).toEqual(PEAK)
  })
})

describe('peaksFromWindows', () => {
  it('gives the same waveform however the file is cut, since each window is placed by what it decoded', async () => {
    const samples = song()
    const whole = await peaksFromWhole(file(samples), decodeFloats, options)
    for (const frames of [48_000, 16_000, 7777, 1001]) {
      const cut = await peaksFromWindows(file(samples), windowsOf(samples.length, frames), decodeFloats, options)
      expect(cut, `windows of ${frames} frames`).toEqual(whole)
    }
  })

  it('reads, decodes and lets go of one window before it touches the next, so memory stays at one window', async () => {
    const samples = song()
    const events: string[] = []
    const real = file(samples)
    const spy = {
      size: real.size,
      slice: (start: number, end: number) => {
        events.push(`read ${start / 4}`)
        return real.slice(start, end)
      },
    } as unknown as Blob
    const decode: DecodeFn = async (data) => {
      events.push(`decode ${data.byteLength / 4}`)
      return decodeFloats(data)
    }
    await peaksFromWindows(spy, windowsOf(samples.length, 16_000), decode, options)
    expect(events).toEqual(['read 0', 'decode 16000', 'read 16000', 'decode 16000', 'read 32000', 'decode 16000'])
  })

  it('lets a window the decoder rejects stand in as silence of the length it should have had, so the rest stays in place', async () => {
    const samples = song()
    let calls = 0
    const flaky: DecodeFn = async (data) => {
      if (++calls === 2) throw new DOMException('Unable to decode audio data', 'EncodingError')
      return decodeFloats(data)
    }
    // three windows of 2 s: loud+loud, silent+quiet (rejected: becomes 2 s of silence), quiet+loud
    const peaks = await peaksFromWindows(file(samples), windowsOf(samples.length, 16_000), flaky, options)
    expect(peaks.duration).toBe(6)
    expect([...peaks.peak]).toEqual([224, 224, 0, 0, 194, 224])
  })

  it('treats a window that decodes to nothing as rejected', async () => {
    const samples = song()
    let calls = 0
    const empty: DecodeFn = async (data) => (++calls === 3 ? { sampleRate: RATE, channels: [new Float32Array(0)] } : decodeFloats(data))
    const peaks = await peaksFromWindows(file(samples), windowsOf(samples.length, 16_000), empty, options)
    expect([...peaks.peak]).toEqual([224, 224, 0, 194, 0, 0])
  })

  it('says "unsupported" when the decoder rejects every window, or most of them', async () => {
    const samples = song()
    const never: DecodeFn = async () => {
      throw new DOMException('Unable to decode audio data', 'EncodingError')
    }
    await expect(peaksFromWindows(file(samples), windowsOf(samples.length, 16_000), never, options)).rejects.toMatchObject({ name: 'AudioDecodeError', code: 'unsupported' })
    await expect(peaksFromWhole(file(samples), never, options)).rejects.toMatchObject({ code: 'unsupported' })
    let calls = 0
    const mostly: DecodeFn = async (data) => {
      if (++calls > 1) throw new DOMException('Unable to decode audio data', 'EncodingError')
      return decodeFloats(data)
    }
    await expect(peaksFromWindows(file(samples), windowsOf(samples.length, 16_000), mostly, options)).rejects.toMatchObject({ code: 'unsupported' })
  })

  it('tolerates losing up to half of the windows', async () => {
    const samples = song()
    let calls = 0
    const half: DecodeFn = async (data) => {
      if (++calls === 1) throw new DOMException('Unable to decode audio data', 'EncodingError')
      return decodeFloats(data)
    }
    // four windows of 1.5 s, one of them lost: that is not "more than half", so the other three are kept and the lost one is silence
    const peaks = await peaksFromWindows(file(samples), windowsOf(samples.length, 12_000), half, options)
    expect(peaks.duration).toBe(6)
    expect([...peaks.peak]).toEqual([0, 224, 0, 194, 194, 224])
  })

  it('reports progress after each window', async () => {
    const samples = song()
    const seen: number[] = []
    await peaksFromWindows(file(samples), windowsOf(samples.length, 16_000), decodeFloats, { ...options, onProgress: (f) => seen.push(f) })
    expect(seen).toEqual([1 / 3, 2 / 3, 1])
  })

  it('stops with an "aborted" error when it is cancelled, without reading the windows that are left', async () => {
    const samples = song()
    const controller = new AbortController()
    let decoded = 0
    const decode: DecodeFn = async (data) => {
      if (++decoded === 1) controller.abort()
      return decodeFloats(data)
    }
    await expect(peaksFromWindows(file(samples), windowsOf(samples.length, 16_000), decode, { ...options, signal: controller.signal })).rejects.toMatchObject({ code: 'aborted' })
    expect(decoded).toBe(1)
  })

  it('has nothing to measure without windows', async () => {
    await expect(peaksFromWindows(file(song()), [], decodeFloats, options)).rejects.toMatchObject({ code: 'unsupported' })
  })
})

describe('browserDecode', () => {
  class FakeContext {
    static made: { channels: number; length: number; sampleRate: number }[] = []
    constructor(channels: number, length: number, sampleRate: number) {
      FakeContext.made.push({ channels, length, sampleRate })
    }
    async decodeAudioData(data: ArrayBuffer) {
      const frames = new Float32Array(data)
      return { sampleRate: DECODE_RATE, numberOfChannels: 2, getChannelData: (c: number) => (c === 0 ? frames : frames.map((x) => -x)) }
    }
  }

  it('asks the browser to decode at a low sample rate, and returns every channel', async () => {
    const decode = browserDecode({ OfflineAudioContext: FakeContext } as unknown as typeof globalThis)
    const out = await decode(Float32Array.from([0.5, 0.25]).buffer)
    expect(FakeContext.made.at(-1)?.sampleRate).toBe(DECODE_RATE)
    expect(out.sampleRate).toBe(DECODE_RATE)
    expect(out.channels.map((c) => [...c])).toEqual([
      [0.5, 0.25],
      [-0.5, -0.25],
    ])
  })

  it('falls back to the prefixed constructor of older WebKit', async () => {
    const decode = browserDecode({ webkitOfflineAudioContext: FakeContext } as unknown as typeof globalThis)
    expect((await decode(Float32Array.from([1]).buffer)).channels).toHaveLength(2)
  })

  it('says "unsupported" in a browser that cannot decode audio at all', async () => {
    await expect(browserDecode({} as typeof globalThis)(new ArrayBuffer(8))).rejects.toMatchObject({ code: 'unsupported' })
  })
})
