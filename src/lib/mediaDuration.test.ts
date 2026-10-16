import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { measureMediaDuration } from './mediaDuration'

/** Just enough of an audio element: events, `src`, `duration`, and a record of being released. */
class FakeMedia extends EventTarget {
  preload = ''
  src = ''
  duration = Number.NaN
  released = false
  removeAttribute(name: string): void {
    if (name === 'src') this.src = ''
  }
  load(): void {
    this.released = true
  }
  fire(type: string, duration?: number): void {
    if (duration !== undefined) this.duration = duration
    this.dispatchEvent(new Event(type))
  }
}

const file = new Blob(['not really audio'])
let created: string[]
let revoked: string[]

beforeEach(() => {
  created = []
  revoked = []
  URL.createObjectURL = vi.fn(() => {
    const url = `blob:mock-${created.length}`
    created.push(url)
    return url
  })
  URL.revokeObjectURL = vi.fn((url: string) => void revoked.push(url))
})

afterEach(() => {
  vi.useRealTimers()
})

const measure = (media: FakeMedia, timeoutMs = 8000) => measureMediaDuration(file, { create: () => media as unknown as HTMLMediaElement, timeoutMs })

describe('measureMediaDuration', () => {
  it('resolves with the duration once the browser has the metadata, then lets go of the file', async () => {
    const media = new FakeMedia()
    const result = measure(media)
    expect(media.preload).toBe('metadata')
    expect(media.src).toBe('blob:mock-0')
    media.fire('loadedmetadata', 187.5)
    expect(await result).toBe(187.5)
    expect(revoked).toEqual(['blob:mock-0'])
    expect(media.src).toBe('')
    expect(media.released).toBe(true)
  })

  it('resolves null when the browser cannot read the file', async () => {
    const media = new FakeMedia()
    const result = measure(media)
    media.fire('error')
    expect(await result).toBeNull()
    expect(revoked).toEqual(['blob:mock-0'])
  })

  it('gives up after the timeout and still lets go of the file', async () => {
    vi.useFakeTimers()
    const media = new FakeMedia()
    const result = measure(media, 5000)
    await vi.advanceTimersByTimeAsync(4999)
    media.fire('loadedmetadata', Number.NaN)
    await vi.advanceTimersByTimeAsync(2)
    expect(await result).toBeNull()
    expect(revoked).toEqual(['blob:mock-0'])
  })

  it('waits for a real duration when the first report is Infinity (a stream of unknown length)', async () => {
    const media = new FakeMedia()
    const result = measure(media)
    media.fire('loadedmetadata', Number.POSITIVE_INFINITY)
    media.fire('durationchange', 123.25)
    expect(await result).toBe(123.25)
  })

  it('does not accept a duration of zero', async () => {
    vi.useFakeTimers()
    const media = new FakeMedia()
    const result = measure(media, 1000)
    media.fire('loadedmetadata', 0)
    await vi.advanceTimersByTimeAsync(1001)
    expect(await result).toBeNull()
  })

  it('resolves once: later events change nothing', async () => {
    const media = new FakeMedia()
    const result = measure(media)
    media.fire('loadedmetadata', 10)
    media.fire('durationchange', 99)
    media.fire('error')
    expect(await result).toBe(10)
    expect(revoked).toHaveLength(1)
  })

  it('resolves null instead of throwing when the element or the URL cannot be made', async () => {
    expect(await measureMediaDuration(file, { create: () => { throw new Error('no audio') } })).toBeNull()
    URL.createObjectURL = vi.fn(() => { throw new Error('no urls') })
    expect(await measure(new FakeMedia())).toBeNull()
  })
})
