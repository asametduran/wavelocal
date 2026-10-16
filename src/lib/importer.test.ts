import { beforeEach, describe, expect, it, vi } from 'vitest'
import { importFiles } from './importer'
import type { ImportOptions } from './importer'
import type { Analysis } from './analyze'
import { fileKey } from './metadata'
import { EMPTY_META, INDEX_VERSION } from './trackmeta'
import type { ImportProgress } from '../types'

const { indexed: _indexed, ...baseMeta } = EMPTY_META
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/** An analysis that answers from a table keyed by file name (anything not in it is an untagged file). */
const analysisOf =
  (table: Record<string, Partial<Analysis>> = {}) =>
  async (file: File): Promise<Analysis> => ({ title: '', artist: '', album: '', meta: { ...baseMeta }, duration: 0, cover: null, lyricsText: '', gainDb: null, ...table[file.name] })

const audio = (name: string, path = '', size = 1, lastModified = 1): File => {
  const file = new File([new Uint8Array(size)], name, { type: 'audio/mpeg', lastModified })
  if (path) Object.defineProperty(file, 'webkitRelativePath', { value: `${path}/${name}` })
  return file
}
const lrc = (name: string, body: string): File => new File([body], name, { type: 'text/plain' })

const run = (files: File[], options: ImportOptions = {}) => importFiles(files, { analyze: analysisOf(), ...options })

beforeEach(() => {
  let n = 0
  URL.createObjectURL = vi.fn(() => `blob:mock-${n++}`)
  URL.revokeObjectURL = vi.fn()
})

describe('importFiles: what gets imported', () => {
  it('orders a selection by folder, then by natural file name', async () => {
    const r = await run([audio('10.mp3', 'Music/B'), audio('2.mp3', 'Music/A'), audio('2.mp3', 'Music/B', 1, 2), audio('10.mp3', 'Music/A', 1, 3), audio('1.mp3', 'Music/A')])
    expect(r.tracks.map((t) => `${t.path}/${t.file.name}`)).toEqual(['Music/A/1.mp3', 'Music/A/2.mp3', 'Music/A/10.mp3', 'Music/B/2.mp3', 'Music/B/10.mp3'])
  })

  it('orders loose files by natural name', async () => {
    const r = await run([audio('track10.mp3'), audio('track2.mp3'), audio('track1.mp3')])
    expect(r.tracks.map((t) => t.file.name)).toEqual(['track1.mp3', 'track2.mp3', 'track10.mp3'])
  })

  it('skips what the library already holds and repeats within the selection, and counts them', async () => {
    const have = audio('a.mp3')
    const r = await run([have, audio('b.mp3'), audio('b.mp3')], { existingKeys: new Set([fileKey(have)]) })
    expect(r.tracks.map((t) => t.file.name)).toEqual(['b.mp3'])
    expect(r.duplicates).toBe(2)
    expect(r.total).toBe(1)
  })

  it('ignores files that are not audio', async () => {
    const r = await run([audio('a.mp3'), new File(['x'], 'notes.txt', { type: 'text/plain' }), new File(['x'], 'cover.jpg', { type: 'image/jpeg' })])
    expect(r.tracks).toHaveLength(1)
    expect(r.duplicates).toBe(0)
  })

  it('gives every track its own id', async () => {
    const r = await run(Array.from({ length: 50 }, (_, i) => audio(`t${i}.mp3`)))
    expect(new Set(r.tracks.map((t) => t.id)).size).toBe(50)
  })

  it('accepts a FileList-like object', async () => {
    const files = [audio('a.mp3'), audio('b.mp3')]
    const list = { length: 2, 0: files[0], 1: files[1] } as unknown as ArrayLike<File>
    expect((await importFiles(list, { analyze: analysisOf() })).tracks).toHaveLength(2)
  })

  it('handles an empty selection', async () => {
    const onBatch = vi.fn()
    const r = await run([], { onBatch })
    expect(r).toMatchObject({ tracks: [], orphanLrc: [], duplicates: 0, failed: 0, cancelled: false, total: 0 })
    expect(onBatch).not.toHaveBeenCalled()
  })
})

describe('importFiles: what a track record gets', () => {
  it('carries the analysis: tags, duration, gain, cover, details and the analysis version', async () => {
    const cover = new Blob(['img'], { type: 'image/png' })
    const analyze = analysisOf({
      'a.mp3': { title: ' Song ', artist: ' Band ', album: ' LP ', duration: 187.5, gainDb: -3.2, cover, meta: { ...baseMeta, trackNo: 3, year: 2019, genre: 'Pop', albumArtist: 'Various', audio: null } },
    })
    const [t] = (await importFiles([audio('a.mp3', 'Music/Rock')], { analyze })).tracks
    expect(t).toMatchObject({ title: 'Song', artist: 'Band', album: 'LP', duration: 187.5, gainDb: -3.2, path: 'Music/Rock', trackNo: 3, year: 2019, genre: 'Pop', albumArtist: 'Various', plays: 0, lastPlayedAt: null, indexed: INDEX_VERSION })
    expect(t?.coverBlob).toBe(cover)
    expect(t?.addedAt).toBeGreaterThan(0)
    expect(t?.key).toBe(fileKey(audio('a.mp3', 'Music/Rock')))
  })

  it('gives every track of one import the same time added, so "recently added" follows the library order, not whichever file was read first', async () => {
    const before = Date.now()
    const analyze = async (file: File): Promise<Analysis> => {
      await new Promise<void>((resolve) => setTimeout(resolve, file.name === 'a.mp3' ? 15 : 0)) // a is the last to finish
      return analysisOf()(file)
    }
    const { tracks } = await importFiles([audio('a.mp3'), audio('b.mp3'), audio('c.mp3')], { analyze, batchSize: 2 })
    const stamps = new Set(tracks.map((t) => t.addedAt))
    expect(stamps.size).toBe(1)
    expect([...stamps][0]).toBeGreaterThanOrEqual(before)
    expect([...stamps][0]).toBeLessThanOrEqual(Date.now())
  })

  it('falls back to the file name and "Unknown Artist" when the tags are empty', async () => {
    const [t] = (await run([audio('My Song.mp3')])).tracks
    expect(t).toMatchObject({ title: 'My Song', artist: 'Unknown Artist', album: '', duration: 0, gainDb: null, coverBlob: null })
  })
})

describe('importFiles: lyrics', () => {
  const synced = '[00:01.00]hello\n[00:02.00]world'

  it('pairs sidecar .lrc files by file name and returns the ones that matched nothing', async () => {
    const r = await run([audio('song.mp3'), lrc('song.lrc', synced), lrc('other.lrc', '[00:01.00]orphan')])
    expect(r.tracks[0]?.lyrics?.synced).toBe(true)
    expect(r.orphanLrc.map((o) => o.name)).toEqual(['other.lrc'])
  })

  it('pairs by title and by "artist - title" as well', async () => {
    const analyze = analysisOf({ 'x.mp3': { title: 'Real Title', artist: 'Real Artist' }, 'y.mp3': { title: 'Other', artist: 'Band' } })
    const r = await importFiles([audio('x.mp3'), audio('y.mp3'), lrc('real title.lrc', synced), lrc('band - other.lrc', synced)], { analyze })
    expect(r.tracks.every((t) => t.lyrics)).toBe(true)
    expect(r.orphanLrc).toEqual([])
  })

  it('uses lyrics embedded in the tags when there is no sidecar', async () => {
    const r = await importFiles([audio('a.mp3')], { analyze: analysisOf({ 'a.mp3': { lyricsText: synced } }) })
    expect(r.tracks[0]?.lyrics?.lines).toHaveLength(2)
  })

  it('ignores an .lrc that is not lyrics', async () => {
    const r = await run([audio('a.mp3'), lrc('a.lrc', '')])
    expect(r.tracks[0]?.lyrics).toBeNull()
    expect(r.orphanLrc).toEqual([])
  })

  it('returns orphan lyrics even when no audio was imported', async () => {
    const r = await run([lrc('only.lrc', synced)])
    expect(r.tracks).toEqual([])
    expect(r.orphanLrc.map((o) => o.name)).toEqual(['only.lrc'])
  })
})

describe('importFiles: batches, concurrency and progress', () => {
  it('commits each batch, in order, before reading the next one', async () => {
    const log: string[] = []
    const analyze = async (file: File): Promise<Analysis> => {
      log.push(`read:${file.name}`)
      await tick()
      return analysisOf()(file)
    }
    const files = Array.from({ length: 8 }, (_, i) => audio(`t${i}.mp3`))
    await importFiles(files, { analyze, batchSize: 3, concurrency: 2, onBatch: (batch) => void log.push(`batch:${batch.map((t) => t.file.name).join(',')}`) })
    expect(log.indexOf('batch:t0.mp3,t1.mp3,t2.mp3')).toBeLessThan(log.indexOf('read:t3.mp3'))
    expect(log.indexOf('batch:t3.mp3,t4.mp3,t5.mp3')).toBeLessThan(log.indexOf('read:t6.mp3'))
    expect(log.filter((l) => l.startsWith('batch:'))).toEqual(['batch:t0.mp3,t1.mp3,t2.mp3', 'batch:t3.mp3,t4.mp3,t5.mp3', 'batch:t6.mp3,t7.mp3'])
  })

  it('never reads more files at once than the concurrency limit', async () => {
    let running = 0
    let peak = 0
    const analyze = async (file: File): Promise<Analysis> => {
      running++
      peak = Math.max(peak, running)
      await tick()
      running--
      return analysisOf()(file)
    }
    await importFiles(
      Array.from({ length: 40 }, (_, i) => audio(`t${i}.mp3`)),
      { analyze, concurrency: 4, batchSize: 40 },
    )
    expect(peak).toBe(4)
  })

  it('reports progress that only moves forward and ends at the total', async () => {
    const seen: ImportProgress[] = []
    await run(
      Array.from({ length: 25 }, (_, i) => audio(`t${i}.mp3`)),
      { batchSize: 10, onProgress: (p) => seen.push({ ...p }) },
    )
    expect(seen[0]).toEqual({ total: 25, done: 0, added: 0 })
    expect(seen.at(-1)).toEqual({ total: 25, done: 25, added: 25 })
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]!.done).toBeGreaterThanOrEqual(seen[i - 1]!.done)
      expect(seen[i]!.added).toBeGreaterThanOrEqual(seen[i - 1]!.added)
      expect(seen[i]!.total).toBe(25)
    }
  })
})

describe('importFiles: cancelling and failing', () => {
  it('stops between batches when cancelled and keeps what was committed', async () => {
    const controller = new AbortController()
    const batches: number[] = []
    const r = await run(
      Array.from({ length: 10 }, (_, i) => audio(`t${i}.mp3`)),
      {
        batchSize: 4,
        signal: controller.signal,
        onBatch: (b) => {
          batches.push(b.length)
          controller.abort()
        },
      },
    )
    expect(batches).toEqual([4])
    expect(r.tracks).toHaveLength(4)
    expect(r.cancelled).toBe(true)
  })

  it('stops starting files as soon as it is cancelled in the middle of a batch, and still commits the ones that finished', async () => {
    const controller = new AbortController()
    let started = 0
    const analyze = async (file: File): Promise<Analysis> => {
      const n = ++started
      await tick()
      if (n === 3) controller.abort()
      return analysisOf()(file)
    }
    const r = await importFiles(
      Array.from({ length: 30 }, (_, i) => audio(`t${i}.mp3`)),
      { analyze, concurrency: 2, batchSize: 30, signal: controller.signal },
    )
    expect(r.cancelled).toBe(true)
    expect(r.tracks.length).toBeGreaterThanOrEqual(3)
    expect(r.tracks.length).toBeLessThan(30)
    expect(r.tracks.length).toBe(started)
  })

  it('does nothing when it was cancelled before it began', async () => {
    const controller = new AbortController()
    controller.abort()
    const analyze = vi.fn(analysisOf())
    const r = await importFiles([audio('a.mp3'), audio('b.mp3')], { analyze, signal: controller.signal })
    expect(analyze).not.toHaveBeenCalled()
    expect(r).toMatchObject({ tracks: [], cancelled: true })
  })

  it('loses only the file that fails', async () => {
    const analyze = async (file: File): Promise<Analysis> => {
      if (file.name === 'bad.mp3') throw new Error('unreadable')
      return analysisOf()(file)
    }
    const r = await importFiles([audio('a.mp3'), audio('bad.mp3'), audio('c.mp3')], { analyze })
    expect(r.tracks.map((t) => t.file.name)).toEqual(['a.mp3', 'c.mp3'])
    expect(r.failed).toBe(1)
    expect(r.cancelled).toBe(false)
  })

  it('lets an error in the batch callback reach the caller instead of hiding it', async () => {
    await expect(run([audio('a.mp3')], { onBatch: () => Promise.reject(new Error('disk full')) })).rejects.toThrow('disk full')
  })
})
