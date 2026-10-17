// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { measureTrack } from './compute'
import type { ComputeDeps } from './compute'
import { DECODE_RATE } from './native'
import type { DecodeFn } from './native'
import type { PeaksTarget } from './service'
import type { Peaks } from './types'
import { blankFormat } from '../audio/probe/types'
import type { AudioFormat } from '../audio/probe/types'
import { encodeWav } from '../../test-utils/wav'
import { sine } from '../../test-utils/signals'

const MiB = 1024 * 1024
const FROM_WORKER: Peaks = { v: 1, duration: 3, length: 1, peak: Uint8Array.of(200), rms: Uint8Array.of(100) }
const tone = (): Float32Array => sine({ frequency: 1000, amplitude: 0.5, seconds: 1, sampleRate: DECODE_RATE })

function rig() {
  const decoded: ArrayBuffer[] = []
  const decode: DecodeFn = async (data) => {
    decoded.push(data)
    return { sampleRate: DECODE_RATE, channels: [tone()] }
  }
  const lossless = vi.fn(async () => FROM_WORKER)
  const deps: ComputeDeps = { lossless, decode }
  return { deps, decoded, lossless }
}

const format = (container: AudioFormat['container'], more: Partial<AudioFormat> = {}): AudioFormat => ({ ...blankFormat(container), sampleRate: 44100, channels: 2, ...more })
const target = (file: Blob, duration: number, fmt: AudioFormat | null = null): PeaksTarget => ({ id: 't', file, duration, format: fmt })

/** An ID3v2 header announcing `payload` bytes of tag after it (sizes are 4 x 7 bits). */
const id3 = (payload: number): Uint8Array<ArrayBuffer> =>
  Uint8Array.of(0x49, 0x44, 0x33, 3, 0, 0, (payload >> 21) & 0x7f, (payload >> 14) & 0x7f, (payload >> 7) & 0x7f, payload & 0x7f)

describe('measureTrack', () => {
  it('sends a WAV file to the worker, found by looking at its first bytes when the record has no format', async () => {
    const { deps, lossless, decoded } = rig()
    const wav = new Blob([encodeWav([tone()], { sampleRate: DECODE_RATE })])
    const signal = new AbortController().signal
    expect(await measureTrack(target(wav, 1), signal, deps)).toBe(FROM_WORKER)
    expect(lossless).toHaveBeenCalledWith(wav, signal)
    expect(decoded).toEqual([])
  })

  it('believes the format stored with the track over the bytes, so nothing is read to decide', async () => {
    const { deps, lossless } = rig()
    const notFlac = new Blob([new Uint8Array(64).fill(7)])
    await measureTrack(target(notFlac, 5, format('flac')), new AbortController().signal, deps)
    expect(lossless).toHaveBeenCalledTimes(1)
  })

  it('cuts an MP3 into windows after its ID3 tag, so the tag is never handed to the decoder', async () => {
    const { deps, decoded, lossless } = rig()
    // a 10-byte header + 1,000 bytes of tag, then 2,000,000 bytes of "audio" (0xab) that last 600 s: 7 windows
    const audio = new Uint8Array(2_000_000).fill(0xab)
    const mp3 = new Blob([id3(1000), new Uint8Array(1000), audio])
    const peaks = await measureTrack(target(mp3, 600, format('mp3')), new AbortController().signal, deps)
    expect(lossless).not.toHaveBeenCalled()
    expect(decoded).toHaveLength(7)
    expect(decoded.reduce((sum, d) => sum + d.byteLength, 0)).toBe(2_000_000)
    expect(new Uint8Array(decoded[0] as ArrayBuffer)[0]).toBe(0xab)
    expect('peak' in peaks && peaks.length).toBeGreaterThan(0)
  })

  it('decodes an MP3 that fits one window in one go', async () => {
    const { deps, decoded } = rig()
    await measureTrack(target(new Blob([new Uint8Array(3 * MiB).fill(1)]), 200, format('mp3')), new AbortController().signal, deps)
    expect(decoded).toHaveLength(1)
    expect(decoded[0]?.byteLength).toBe(3 * MiB)
  })

  it('decodes other formats whole, when the decoded audio fits in memory', async () => {
    const { deps, decoded } = rig()
    const m4a = new Blob([new Uint8Array(4 * MiB).fill(2)])
    const peaks = await measureTrack(target(m4a, 240, format('mp4', { codec: 'aac' })), new AbortController().signal, deps)
    expect(decoded).toHaveLength(1)
    expect(decoded[0]?.byteLength).toBe(4 * MiB)
    expect('peak' in peaks).toBe(true)
  })

  it('does not even try a file whose decoded audio would not fit in memory: it says why', async () => {
    const { deps, decoded, lossless } = rig()
    const long = new Blob([new Uint8Array(MiB)])
    // 4,000 s of stereo 44.1 kHz floats is 1.4 GB
    expect(await measureTrack(target(long, 4000, format('mp4')), new AbortController().signal, deps)).toEqual({ v: 1, none: 'too-long' })
    expect(decoded).toEqual([])
    expect(lossless).not.toHaveBeenCalled()
  })

  it('tries an unrecognised file when it is small, and lets the decoder say whether it is audio', async () => {
    const { deps, decoded } = rig()
    await measureTrack(target(new Blob([new Uint8Array(MiB)]), 0, null), new AbortController().signal, deps)
    expect(decoded).toHaveLength(1)
  })

  it('stops with an "aborted" error when it is cancelled before the windows are decoded', async () => {
    const { deps, decoded } = rig()
    const controller = new AbortController()
    controller.abort()
    const mp3 = new Blob([new Uint8Array(3 * MiB)])
    await expect(measureTrack(target(mp3, 200, format('mp3')), controller.signal, deps)).rejects.toMatchObject({ code: 'aborted' })
    expect(decoded).toEqual([])
  })
})
