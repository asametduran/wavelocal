import { describe, expect, it } from 'vitest'
import { needsUpgrade, upgradeLibrary, upgradePatch } from './upgrade'
import type { UpgradeTarget } from './upgrade'
import type { Analysis } from './analyze'
import { EMPTY_META, INDEX_VERSION } from './trackmeta'
import type { AudioFormat } from './audio/probe/types'
import type { UpgradeProgress } from '../types'

const { indexed: _indexed, ...baseMeta } = EMPTY_META
const audio: AudioFormat = { container: 'mp3', codec: 'mp3', sampleRate: 44100, channels: 2, bitrate: 128000, bitDepth: 0, lossless: false, vbr: false, encoderDelay: 0, encoderPadding: 0 }
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

const analysis = (over: Partial<Analysis> = {}, meta: Partial<Analysis['meta']> = {}): Analysis => ({
  title: 'Tag Title',
  artist: 'Tag Artist',
  album: 'Tag Album',
  meta: { ...baseMeta, ...meta },
  duration: 0,
  cover: new Blob(['img']),
  lyricsText: '[00:01.00]x',
  gainDb: null,
  ...over,
})

const legacy = { ...EMPTY_META, duration: 0, gainDb: null as number | null }

describe('needsUpgrade', () => {
  it('is true for a record that was never analysed or analysed by an older version', () => {
    expect(needsUpgrade({ indexed: 0 })).toBe(true)
    expect(needsUpgrade({ indexed: INDEX_VERSION - 1 })).toBe(true)
    expect(needsUpgrade({} as { indexed: number })).toBe(true)
  })

  it('is false once analysed, and for a record from a newer version of the app', () => {
    expect(needsUpgrade({ indexed: INDEX_VERSION })).toBe(false)
    expect(needsUpgrade({ indexed: INDEX_VERSION + 3 })).toBe(false)
  })
})

describe('upgradePatch', () => {
  it('fills everything that is still unknown and stamps the analysis version', () => {
    const a = analysis(
      { duration: 187.5, gainDb: -4.2 },
      { audio, albumArtist: 'The Band', trackNo: 3, trackTotal: 12, discNo: 1, discTotal: 2, year: 2019, genre: 'Pop', compilation: true },
    )
    expect(upgradePatch(legacy, a)).toEqual({
      indexed: INDEX_VERSION,
      duration: 187.5,
      audio,
      albumArtist: 'The Band',
      trackNo: 3,
      trackTotal: 12,
      discNo: 1,
      discTotal: 2,
      year: 2019,
      genre: 'Pop',
      compilation: true,
      gainDb: -4.2,
    })
  })

  it('never overwrites what the record already knows (a measured loudness, a duration learned while playing, an edited genre)', () => {
    const known = { ...legacy, duration: 200, gainDb: -1, audio: { ...audio, bitrate: 320000 }, albumArtist: 'Mine', trackNo: 9, trackTotal: 10, discNo: 2, discTotal: 3, year: 1999, genre: 'Jazz', compilation: true }
    const a = analysis({ duration: 187.5, gainDb: -4.2 }, { audio, albumArtist: 'Other', trackNo: 3, trackTotal: 12, discNo: 1, discTotal: 2, year: 2019, genre: 'Pop', compilation: false })
    expect(upgradePatch(known, a)).toEqual({ indexed: INDEX_VERSION })
  })

  it('never touches what a person can edit: title, artist, album, artwork, lyrics', () => {
    const keys = Object.keys(upgradePatch(legacy, analysis({ duration: 10 }, { audio, year: 2000 })))
    for (const forbidden of ['title', 'artist', 'album', 'coverBlob', 'cover', 'lyrics', 'file', 'plays', 'addedAt']) expect(keys).not.toContain(forbidden)
  })

  it('takes a track total on its own when the number is already known', () => {
    expect(upgradePatch({ ...legacy, trackNo: 3 }, analysis({}, { trackNo: 3, trackTotal: 12 }))).toEqual({ indexed: INDEX_VERSION, trackTotal: 12 })
  })

  it('leaves out a total that is smaller than the known number', () => {
    expect(upgradePatch({ ...legacy, trackNo: 14 }, analysis({}, { trackNo: 3, trackTotal: 12 }))).toEqual({ indexed: INDEX_VERSION })
  })

  it('does not invent values from an analysis that found nothing', () => {
    expect(upgradePatch(legacy, analysis())).toEqual({ indexed: INDEX_VERSION })
  })

  it('stamps the version even when the file could not be analysed at all', () => {
    expect(upgradePatch(legacy, null)).toEqual({ indexed: INDEX_VERSION })
  })
})

describe('upgradeLibrary', () => {
  const targets = (n: number): UpgradeTarget[] => Array.from({ length: n }, (_, i) => ({ id: `t${i}`, file: new Blob([`file ${i}`]) }))
  const answer = async (): Promise<Analysis> => analysis({ duration: 1 })

  it('analyses every target and hands the results over in batches', async () => {
    const sizes: number[] = []
    const seen = new Set<string>()
    const r = await upgradeLibrary(targets(23), {
      batchSize: 10,
      analyze: answer,
      onBatch: (batch) => {
        sizes.push(batch.size)
        for (const id of batch.keys()) seen.add(id)
      },
    })
    expect(sizes).toEqual([10, 10, 3])
    expect(seen.size).toBe(23)
    expect(r).toEqual({ done: 23, cancelled: false })
  })

  it('reports progress that only moves forward and ends at the total', async () => {
    const seen: UpgradeProgress[] = []
    await upgradeLibrary(targets(25), { batchSize: 10, analyze: answer, onBatch: () => {}, onProgress: (p) => seen.push({ ...p }) })
    expect(seen[0]).toEqual({ total: 25, done: 0 })
    expect(seen.at(-1)).toEqual({ total: 25, done: 25 })
    for (let i = 1; i < seen.length; i++) expect(seen[i]!.done).toBeGreaterThanOrEqual(seen[i - 1]!.done)
  })

  it('never analyses more files at once than the concurrency limit', async () => {
    let running = 0
    let peak = 0
    await upgradeLibrary(targets(30), {
      concurrency: 3,
      batchSize: 30,
      analyze: async () => {
        running++
        peak = Math.max(peak, running)
        await tick()
        running--
        return analysis()
      },
      onBatch: () => {},
    })
    expect(peak).toBe(3)
  })

  it('gives a failed analysis as null, so the record can still be stamped', async () => {
    const results = new Map<string, Analysis | null>()
    await upgradeLibrary(targets(3), {
      analyze: async (file) => {
        if ((await file.text()) === 'file 1') throw new Error('unreadable')
        return analysis({ duration: 5 })
      },
      onBatch: (batch) => batch.forEach((v, k) => results.set(k, v)),
    })
    expect(results.get('t0')?.duration).toBe(5)
    expect(results.get('t1')).toBeNull()
    expect(results.get('t2')?.duration).toBe(5)
  })

  it('stops between batches when cancelled and says so', async () => {
    const controller = new AbortController()
    const batches: number[] = []
    const r = await upgradeLibrary(targets(30), {
      batchSize: 10,
      analyze: answer,
      signal: controller.signal,
      onBatch: (b) => {
        batches.push(b.size)
        controller.abort()
      },
    })
    expect(batches).toEqual([10])
    expect(r).toEqual({ done: 10, cancelled: true })
  })

  it('stops starting files when cancelled in the middle of a batch, and still hands over the finished ones', async () => {
    const controller = new AbortController()
    let started = 0
    const handed: number[] = []
    const r = await upgradeLibrary(targets(40), {
      concurrency: 2,
      batchSize: 40,
      signal: controller.signal,
      analyze: async () => {
        const n = ++started
        await tick()
        if (n === 4) controller.abort()
        return analysis()
      },
      onBatch: (b) => void handed.push(b.size),
    })
    expect(r.cancelled).toBe(true)
    expect(handed[0]).toBe(started)
    expect(started).toBeLessThan(40)
  })

  it('does nothing for an empty list or an already cancelled run', async () => {
    let calls = 0
    const onBatch = () => void calls++
    expect(await upgradeLibrary([], { analyze: answer, onBatch })).toEqual({ done: 0, cancelled: false })
    const controller = new AbortController()
    controller.abort()
    expect(await upgradeLibrary(targets(5), { analyze: answer, onBatch, signal: controller.signal })).toEqual({ done: 0, cancelled: true })
    expect(calls).toBe(0)
  })
})
