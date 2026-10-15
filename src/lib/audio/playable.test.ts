import { describe, expect, it, vi } from 'vitest'
import { encodeFlac } from '../../test-utils/flac-encoder'
import { encodeWav } from '../../test-utils/wav'
import type { ConvertResult } from './convert'
import { AudioDecodeError } from './pcm'
import { PlayableResolver } from './playable'
import type { ConvertFn, PlayableTrack } from './playable'

const flacBytes = () => encodeFlac([Int32Array.from({ length: 3000 }, (_, i) => Math.round(Math.sin(i / 12) * 9000))], { sampleRate: 44100, bitsPerSample: 16 })
const wavBytes = () => encodeWav([Float32Array.from({ length: 800 }, (_, i) => Math.sin(i / 7) * 0.4)], { format: 'pcm16' })

let nextId = 1
const track = (bytes: Uint8Array<ArrayBuffer>, name: string, type = ''): PlayableTrack => {
  const id = `t${nextId++}`
  return { id, url: `blob:original-${id}`, file: new File([bytes], name, { type }) }
}

const result = (): ConvertResult => ({
  blob: new Blob([new Uint8Array(44)], { type: 'audio/wav' }),
  container: 'flac',
  sampleRate: 44100,
  channels: 2,
  sourceChannels: 2,
  sourceBitsPerSample: 16,
  frames: 100,
  duration: 100 / 44100,
  warnings: [],
})

/** A resolver with a fake converter and URL functions, so no real decoding happens. */
function setup(options: { element?: Pick<HTMLMediaElement, 'canPlayType'> | null; convert?: ConvertFn; cacheSize?: number } = {}) {
  let urlCounter = 0
  const convert = vi.fn<ConvertFn>(options.convert ?? (async (_file, o) => {
    o.onProgress?.(0.5)
    return result()
  }))
  const revoked: string[] = []
  const resolver = new PlayableResolver({
    convert,
    element: options.element === undefined ? { canPlayType: () => '' } : options.element,
    cacheSize: options.cacheSize,
    createUrl: () => `blob:converted-${++urlCounter}`,
    revokeUrl: (url) => revoked.push(url),
  })
  return { resolver, convert, revoked }
}

const cannotPlay: Pick<HTMLMediaElement, 'canPlayType'> = { canPlayType: () => '' }
const canPlay: Pick<HTMLMediaElement, 'canPlayType'> = { canPlayType: () => 'probably' }

describe('urlFor (the synchronous path)', () => {
  it('gives ordinary files straight back, with no sniffing', () => {
    const { resolver, convert } = setup()
    const mp3 = track(new Uint8Array(100), 'song.mp3', 'audio/mpeg')
    expect(resolver.urlFor(mp3)).toBe(mp3.url)
    expect(convert).not.toHaveBeenCalled()
  })

  it('cannot answer for WAV/FLAC until it has looked inside', () => {
    const { resolver } = setup()
    expect(resolver.urlFor(track(flacBytes(), 'song.flac'))).toBeNull()
    expect(resolver.urlFor(track(wavBytes(), 'song.wav'))).toBeNull()
  })
})

describe('resolve', () => {
  it('hands native files to the browser untouched, and remembers the verdict', async () => {
    const { resolver, convert } = setup({ element: canPlay })
    const t = track(flacBytes(), 'song.flac', 'audio/flac')
    expect(await resolver.resolve(t)).toBe(t.url)
    expect(resolver.urlFor(t)).toBe(t.url) // now answerable synchronously
    expect(convert).not.toHaveBeenCalled()
  })

  it('decodes FLAC when the browser cannot play it', async () => {
    const { resolver, convert } = setup({ element: cannotPlay })
    const t = track(flacBytes(), 'song.flac', 'audio/flac')
    const url = await resolver.resolve(t)
    expect(url).toBe('blob:converted-1')
    expect(convert).toHaveBeenCalledTimes(1)
    expect(resolver.urlFor(t)).toBe(url) // cached
    expect(await resolver.resolve(t)).toBe(url)
    expect(convert).toHaveBeenCalledTimes(1)
  })

  it('identifies files by content, not by name', async () => {
    const { resolver, convert } = setup({ element: cannotPlay })
    const disguised = track(flacBytes(), 'mystery.dat', 'audio/flac') // type says FLAC, name does not
    await resolver.resolve(disguised)
    expect(convert).toHaveBeenCalledTimes(1)

    const liar = track(new Uint8Array(500), 'fake.flac', 'audio/flac') // named FLAC but is not
    expect(await resolver.resolve(liar)).toBe(liar.url)
    expect(convert).toHaveBeenCalledTimes(1)
  })

  it('shares one conversion between simultaneous requests', async () => {
    const { resolver, convert } = setup({ element: cannotPlay })
    const t = track(flacBytes(), 'song.flac')
    const urls = await Promise.all([resolver.resolve(t), resolver.resolve(t), resolver.resolve(t)])
    expect(new Set(urls).size).toBe(1)
    expect(convert).toHaveBeenCalledTimes(1)
  })

  it('decodes exotic WAV even when the browser plays WAV', async () => {
    const { resolver, convert } = setup({ element: canPlay })
    const rf64 = wavBytes().slice()
    rf64.set([0x52, 0x46, 0x36, 0x34], 0)
    await resolver.resolve(track(rf64, 'big.wav', 'audio/wav'))
    expect(convert).toHaveBeenCalledTimes(1)
    await resolver.resolve(track(wavBytes(), 'plain.wav', 'audio/wav'))
    expect(convert).toHaveBeenCalledTimes(1)
  })

  it('assumes the browser can play when there is nothing to ask', async () => {
    const { resolver, convert } = setup({ element: null })
    const t = track(flacBytes(), 'a.flac')
    expect(await resolver.resolve(t)).toBe(t.url)
    expect(convert).not.toHaveBeenCalled()
  })
})

describe('forceDecode (the browser failed on the original)', () => {
  it('converts even though detection said the browser could play it', async () => {
    const { resolver, convert } = setup({ element: canPlay })
    const t = track(flacBytes(), 'a.flac')
    expect(await resolver.resolve(t)).toBe(t.url)
    const url = await resolver.forceDecode(t)
    expect(url).toBe('blob:converted-1')
    expect(convert).toHaveBeenCalledTimes(1)
    expect(resolver.urlFor(t)).toBe(url) // from now on the converted copy is used
  })

  it('does not convert twice', async () => {
    const { resolver, convert } = setup()
    const t = track(wavBytes(), 'a.wav')
    const [a, b] = await Promise.all([resolver.forceDecode(t), resolver.forceDecode(t)])
    expect(a).toBe(b)
    expect(await resolver.forceDecode(t)).toBe(a)
    expect(convert).toHaveBeenCalledTimes(1)
  })

  it('knows whether a file is decodable at all', async () => {
    const { resolver } = setup()
    expect(await resolver.isDecodable(track(flacBytes(), 'a.bin'))).toBe(true)
    expect(await resolver.isDecodable(track(wavBytes(), 'a.bin'))).toBe(true)
    expect(await resolver.isDecodable(track(new Uint8Array(300), 'a.mp3'))).toBe(false)
  })
})

describe('progress', () => {
  it('announces start, progress and completion', async () => {
    const { resolver } = setup()
    const events: [string, number | null][] = []
    resolver.onProgress((id, fraction) => events.push([id, fraction]))
    const t = track(flacBytes(), 'a.flac')
    await resolver.resolve(t)
    expect(events).toEqual([
      [t.id, 0],
      [t.id, 0.5],
      [t.id, null],
    ])
    expect(resolver.progressOf(t.id)).toBeNull()
  })

  it('exposes the running fraction and lets listeners unsubscribe', async () => {
    let release: (r: ConvertResult) => void = () => {}
    let report: (f: number) => void = () => {}
    const { resolver } = setup({
      convert: (_file, o) =>
        new Promise((resolve) => {
          report = o.onProgress ?? (() => {})
          release = resolve
        }),
    })
    const events: (number | null)[] = []
    const off = resolver.onProgress((_id, f) => events.push(f))
    const t = track(flacBytes(), 'a.flac')
    const pending = resolver.resolve(t)
    await vi.waitFor(() => expect(resolver.progressOf(t.id)).toBe(0))
    report(0.4)
    expect(resolver.progressOf(t.id)).toBe(0.4)
    off()
    report(0.9)
    expect(events).toEqual([0, 0.4])
    release(result())
    await pending
  })
})

describe('failure and cancellation', () => {
  it('passes decode errors on and allows a retry', async () => {
    let attempt = 0
    const { resolver } = setup({
      convert: async () => {
        if (++attempt === 1) throw new AudioDecodeError('broken stream', 'corrupt')
        return result()
      },
    })
    const t = track(flacBytes(), 'a.flac')
    await expect(resolver.resolve(t)).rejects.toMatchObject({ code: 'corrupt', message: 'broken stream' })
    expect(resolver.progressOf(t.id)).toBeNull()
    expect(await resolver.resolve(t)).toBe('blob:converted-1')
  })

  it('release() aborts a running job and drops cached audio', async () => {
    let signal: AbortSignal | undefined
    const { resolver, revoked } = setup({
      convert: (_file, o) => {
        signal = o.signal
        return new Promise((_resolve, reject) => o.signal?.addEventListener('abort', () => reject(new AudioDecodeError('cancelled', 'aborted'))))
      },
    })
    const t = track(flacBytes(), 'a.flac')
    const pending = resolver.resolve(t)
    await vi.waitFor(() => expect(signal).toBeDefined())
    resolver.release(t.id)
    expect(signal?.aborted).toBe(true)
    await expect(pending).rejects.toMatchObject({ code: 'aborted' })
    expect(revoked).toEqual([])

    const done = setup()
    const u = track(flacBytes(), 'b.flac')
    const url = await done.resolver.resolve(u)
    done.resolver.release(u.id)
    expect(done.revoked).toEqual([url])
    expect(done.resolver.urlFor(u)).toBeNull() // the verdict is forgotten too
  })

  it('a result that arrives after release is thrown away', async () => {
    let finish: (r: ConvertResult) => void = () => {}
    const { resolver, revoked } = setup({ convert: () => new Promise((resolve) => (finish = resolve)) })
    const t = track(flacBytes(), 'a.flac')
    const pending = resolver.resolve(t)
    await vi.waitFor(() => expect(resolver.progressOf(t.id)).toBe(0))
    resolver.release(t.id)
    finish(result())
    await expect(pending).rejects.toMatchObject({ code: 'aborted' })
    expect(resolver.urlFor(t)).toBeNull()
    expect(revoked).toEqual([])
  })

  it('releaseAll clears everything', async () => {
    const { resolver, revoked } = setup()
    const tracks = [track(flacBytes(), 'a.flac'), track(flacBytes(), 'b.flac')]
    for (const t of tracks) await resolver.resolve(t)
    resolver.releaseAll()
    expect(revoked).toHaveLength(2)
    for (const t of tracks) expect(resolver.urlFor(t)).toBeNull()
  })
})

describe('cache', () => {
  it('evicts the least recently used conversion beyond its size, revoking the URL', async () => {
    const { resolver, revoked } = setup({ cacheSize: 2 })
    const [a, b, c] = [track(flacBytes(), 'a.flac'), track(flacBytes(), 'b.flac'), track(flacBytes(), 'c.flac')]
    const urlA = await resolver.resolve(a)
    await resolver.resolve(b)
    expect(resolver.urlFor(a)).toBe(urlA) // touching a makes b the oldest
    await resolver.resolve(c)
    expect(revoked).toEqual(['blob:converted-2'])
    expect(resolver.urlFor(b)).toBeNull()
    expect(resolver.urlFor(a)).toBe(urlA)
  })

  it('never evicts retained tracks (the ones loaded into a deck)', async () => {
    const { resolver, revoked } = setup({ cacheSize: 1 })
    const [a, b, c] = [track(flacBytes(), 'a.flac'), track(flacBytes(), 'b.flac'), track(flacBytes(), 'c.flac')]
    resolver.retain([a.id, b.id])
    await resolver.resolve(a)
    await resolver.resolve(b)
    await resolver.resolve(c)
    expect(revoked).toEqual(['blob:converted-3']) // c is the only one not in use, so it goes
    expect(resolver.urlFor(a)).toBe('blob:converted-1')
    expect(resolver.urlFor(b)).toBe('blob:converted-2')
  })
})
