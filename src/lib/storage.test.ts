// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { NotSavingError } from './persist/gate'
import {
  assessStorage,
  breakdown,
  describeSaveFailure,
  formatBytes,
  formatPercent,
  importFit,
  isQuotaError,
  largestTracks,
  libraryUsage,
  readEstimate,
  readPersisted,
  requestPersistence,
  resetWarnings,
  shouldWarn,
  warningFor,
} from './storage'
import type { StorageApi, StorageEstimate } from './storage'

const GB = 1e9
const MB = 1e6
const estimate = (usage: number, quota: number): StorageEstimate => ({ usage, quota, details: null })

describe('readEstimate', () => {
  it('reads usage and quota', async () => {
    const api: StorageApi = { estimate: async () => ({ usage: 12 * MB, quota: 2 * GB }) }
    expect(await readEstimate(api)).toEqual({ usage: 12 * MB, quota: 2 * GB, details: null })
  })

  it('reads the browser\'s own split when it gives one', async () => {
    const api: StorageApi = { estimate: async () => ({ usage: 10, quota: 100, usageDetails: { indexedDB: 6, caches: 3, serviceWorkerRegistrations: 1 } }) }
    expect((await readEstimate(api))?.details).toEqual({ indexedDB: 6, caches: 3, serviceWorker: 1 })
  })

  it.each([
    ['no storage API', undefined],
    ['no estimate function', {}],
    ['a quota of zero', { estimate: async () => ({ usage: 1, quota: 0 }) }],
    ['a missing usage', { estimate: async () => ({ quota: 5 }) }],
    ['a negative number', { estimate: async () => ({ usage: -1, quota: 5 }) }],
    ['NaN', { estimate: async () => ({ usage: Number.NaN, quota: 5 }) }],
    ['a string', { estimate: async () => ({ usage: '1', quota: 5 }) as never }],
    ['a rejection', { estimate: async () => Promise.reject(new Error('denied')) }],
    ['a throw', { estimate: () => { throw new Error('denied') } }],
  ])('gives null for %s instead of throwing', async (_label, api) => {
    expect(await readEstimate(api as StorageApi | undefined)).toBeNull()
  })

  it('leaves the split out when only part of it is usable', async () => {
    const api: StorageApi = { estimate: async () => ({ usage: 10, quota: 100, usageDetails: { indexedDB: 'x', caches: 3 } }) }
    expect((await readEstimate(api))?.details).toBeNull()
  })
})

describe('persistence', () => {
  it('reports whether the browser will keep the data', async () => {
    expect(await readPersisted({ persisted: async () => true })).toBe(true)
    expect(await readPersisted({ persisted: async () => false })).toBe(false)
  })

  it('says it does not know where the browser cannot tell', async () => {
    expect(await readPersisted(undefined)).toBeNull()
    expect(await readPersisted({})).toBeNull()
    expect(await readPersisted({ persisted: async () => Promise.reject(new Error('x')) })).toBeNull()
  })

  it('asks the browser to keep the data and passes its answer on', async () => {
    expect(await requestPersistence({ persist: async () => true })).toBe(true)
    expect(await requestPersistence({ persist: async () => false })).toBe(false)
    expect(await requestPersistence({})).toBeNull()
    expect(await requestPersistence({ persist: async () => Promise.reject(new Error('x')) })).toBeNull()
  })
})

describe('assessStorage', () => {
  it('knows nothing without an estimate', () => {
    expect(assessStorage(null)).toMatchObject({ level: 'unknown', fraction: 0 })
  })

  it.each([
    [0, 'ok'],
    [0.5 * 60 * GB, 'ok'],
    [0.79 * 60 * GB, 'ok'],
    [0.8 * 60 * GB, 'warn'],
    [0.94 * 60 * GB, 'warn'],
    [0.95 * 60 * GB, 'critical'],
    [60 * GB, 'critical'],
  ])('usage %d of 60 GB is %s', (usage, level) => {
    expect(assessStorage(estimate(usage, 60 * GB)).level).toBe(level)
  })

  it('calls little room left a warning, and almost none critical, even when the share used is moderate', () => {
    // 50% of a small quota used, but only 200 MB left: an import of an album would not fit
    expect(assessStorage(estimate(200 * MB, 400 * MB))).toMatchObject({ level: 'warn', fraction: 0.5 })
    // 90% used is only a warning by share, but 40 MB left is too little to add even one song
    expect(assessStorage(estimate(360 * MB, 400 * MB))).toMatchObject({ level: 'critical', fraction: 0.9 })
    expect(assessStorage(estimate(1 * GB - 30 * MB, 1 * GB)).level).toBe('critical')
  })

  it('does not call a big quota that is mostly full critical while plenty is left', () => {
    // 90% of 100 GB used: a warning by share, and 10 GB is plenty of room
    expect(assessStorage(estimate(90 * GB, 100 * GB)).level).toBe('warn')
  })

  it('does not warn about a roomy site for being a small fraction of a small quota', () => {
    expect(assessStorage(estimate(10 * MB, 2 * GB)).level).toBe('ok')
  })

  it('caps the fraction at 1 and the free space at 0 when usage passes the quota', () => {
    expect(assessStorage(estimate(3 * GB, 2 * GB))).toMatchObject({ fraction: 1, free: 0, level: 'critical' })
  })

  it('reports the free bytes', () => {
    expect(assessStorage(estimate(1 * GB, 4 * GB)).free).toBe(3 * GB)
  })
})

describe('formatBytes and formatPercent', () => {
  it.each([
    [0, '0 B'],
    [999, '999 B'],
    [1000, '1.00 kB'],
    [1_536, '1.54 kB'],
    [12_345, '12.3 kB'],
    [312_000_000, '312 MB'],
    [1_430_000_000, '1.43 GB'],
    [59_600_000_000, '59.6 GB'],
    [1.2e12, '1.20 TB'],
    [5e15, '5000 TB'],
  ])('%d is %s', (bytes, text) => {
    expect(formatBytes(bytes)).toBe(text)
  })

  it('shows nonsense as zero', () => {
    expect(formatBytes(-5)).toBe('0 B')
    expect(formatBytes(Number.NaN)).toBe('0 B')
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('0 B')
  })

  it('shows small shares with a decimal so they do not read as nothing', () => {
    expect(formatPercent(0)).toBe('0%')
    expect(formatPercent(0.004)).toBe('0.4%')
    expect(formatPercent(0.5)).toBe('50%')
    expect(formatPercent(1)).toBe('100%')
  })
})

describe('isQuotaError and describeSaveFailure', () => {
  it.each([
    [new DOMException('full', 'QuotaExceededError'), true],
    [{ name: 'QuotaExceededError' }, true],
    [{ code: 22 }, true],
    [{ message: 'The quota has been exceeded.' }, true],
    [new DOMException('x', 'AbortError'), false],
    [new Error('disk quotation'), false],
    [new Error('anything'), false],
    [null, false],
    [undefined, false],
    ['QuotaExceededError', false],
  ])('%j -> %s', (error, expected) => {
    expect(isQuotaError(error)).toBe(expected)
  })

  it('gives out-of-space its own advice, which points to where space can be freed', () => {
    const text = describeSaveFailure(new DOMException('full', 'QuotaExceededError'), 'fallback')
    expect(text).toMatch(/out of storage space/i)
    expect(text).toMatch(/Sound & tools/)
  })

  it('keeps the specific text for any other failure', () => {
    expect(describeSaveFailure(new Error('blocked'), 'Could not save the reset')).toBe('Could not save the reset')
  })

  it('says that a window which is not saving is not saving, in the words of the window, rather than blaming the storage', () => {
    expect(describeSaveFailure(new NotSavingError('memory'), 'Could not save the reset')).toBe('Wavelocal is not saving in this window, so this change is lost when the window closes.')
    expect(describeSaveFailure(new NotSavingError('taken'), 'Could not save the reset')).toBe('Another window of Wavelocal has taken over the library, so this change is not saved.')
  })
})

describe('warningFor', () => {
  it('has nothing to say while there is room', () => {
    expect(warningFor(assessStorage(estimate(GB, 60 * GB)), false)).toBeNull()
    expect(warningFor(assessStorage(null), null)).toBeNull()
  })

  it('says how much is left', () => {
    const warning = warningFor(assessStorage(estimate(50 * GB, 60 * GB)), true)
    expect(warning?.level).toBe('warn')
    expect(warning?.text).toContain('10.0 GB left')
  })

  it('is stronger when almost full', () => {
    const warning = warningFor(assessStorage(estimate(58 * GB, 60 * GB)), true)
    expect(warning?.level).toBe('critical')
    expect(warning?.text).toMatch(/almost full/i)
  })

  it('adds that the browser may delete the library only when it has not promised to keep it', () => {
    const near = assessStorage(estimate(50 * GB, 60 * GB))
    expect(warningFor(near, false)?.text).toMatch(/may also delete/i)
    expect(warningFor(near, true)?.text).not.toMatch(/delete/i)
    expect(warningFor(near, null)?.text).not.toMatch(/delete/i)
  })
})

describe('shouldWarn', () => {
  beforeEach(resetWarnings)

  it('warns when storage gets worse, once per level', () => {
    expect(shouldWarn('ok')).toBe(false)
    expect(shouldWarn('warn')).toBe(true)
    expect(shouldWarn('warn')).toBe(false)
    expect(shouldWarn('critical')).toBe(true)
    expect(shouldWarn('critical')).toBe(false)
    expect(shouldWarn('warn')).toBe(false)
  })

  it('warns again after room was made and storage fills up again', () => {
    expect(shouldWarn('warn')).toBe(true)
    expect(shouldWarn('ok')).toBe(false)
    expect(shouldWarn('warn')).toBe(true)
  })

  it('never warns about an unknown level', () => {
    expect(shouldWarn('unknown')).toBe(false)
  })
})

describe('importFit', () => {
  it('fits when the files are smaller than the room left', () => {
    expect(importFit([100 * MB, 200 * MB], estimate(GB, 2 * GB))).toEqual({ fits: true, needed: 300 * MB, free: GB })
  })

  it('does not fit when they are bigger', () => {
    const result = importFit([600 * MB, 600 * MB], estimate(GB, 2 * GB))
    expect(result.fits).toBe(false)
    expect(result.needed).toBe(1200 * MB)
    expect(result.free).toBe(GB)
  })

  it('fits exactly when the files fill the room exactly', () => {
    expect(importFit([GB], estimate(GB, 2 * GB)).fits).toBe(true)
  })

  it('assumes it fits when the browser does not say, rather than blocking the import', () => {
    expect(importFit([GB], null)).toMatchObject({ fits: true, needed: GB })
  })

  it('ignores sizes that are not numbers', () => {
    expect(importFit([10, Number.NaN, -5, Number.POSITIVE_INFINITY], null).needed).toBe(10)
  })

  it('fits an empty import anywhere', () => {
    expect(importFit([], estimate(2 * GB, 2 * GB)).fits).toBe(true)
  })
})

describe('library usage', () => {
  const track = (id: string, title: string, bytes: number, cover = 0, plays = 0) => ({
    id,
    title,
    artist: 'A',
    file: { size: bytes },
    coverBlob: cover ? { size: cover } : null,
    plays,
    lastPlayedAt: plays ? 1 : null,
  })
  const library = [track('1', 'Small', 1000), track('2', 'Big', 9000, 500), track('3', 'Also big', 9000), track('4', 'Medium', 5000, 0, 3)]

  it('adds up the audio and the artwork', () => {
    expect(libraryUsage(library)).toEqual({ tracks: 4, audioBytes: 24_000, coverBytes: 500, total: 24_500 })
    expect(libraryUsage([])).toEqual({ tracks: 0, audioBytes: 0, coverBytes: 0, total: 0 })
  })

  it('lists the biggest first, counting artwork, with ties in title order', () => {
    expect(largestTracks(library, 3).map((t) => [t.title, t.bytes])).toEqual([
      ['Big', 9500],
      ['Also big', 9000],
      ['Medium', 5000],
    ])
  })

  it('carries what is needed to decide what to remove', () => {
    expect(largestTracks(library, 10).find((t) => t.id === '4')).toEqual({ id: '4', title: 'Medium', artist: 'A', bytes: 5000, plays: 3, lastPlayedAt: 1 })
  })

  it('copes with a limit of zero, a negative limit and an empty library', () => {
    expect(largestTracks(library, 0)).toEqual([])
    expect(largestTracks(library, -3)).toEqual([])
    expect(largestTracks([], 5)).toEqual([])
  })

  it('does not change the library it is given', () => {
    const before = library.map((t) => t.id)
    largestTracks(library, 2)
    expect(library.map((t) => t.id)).toEqual(before)
  })
})

describe('breakdown', () => {
  it('splits the usage into music, the app and the rest', () => {
    expect(breakdown(1000, 600, 100)).toEqual({ music: 600, app: 100, other: 300 })
  })

  it('never reports more than was used, whatever the estimate says', () => {
    expect(breakdown(500, 600, 100)).toEqual({ music: 500, app: 0, other: 0 })
    expect(breakdown(0, 600, 100)).toEqual({ music: 0, app: 0, other: 0 })
  })

  it('always adds up to the usage', () => {
    for (const [usage, music, app] of [[1000, 200, 300], [10, 3, 99], [0, 0, 0], [77, 77, 0]] as const) {
      const b = breakdown(usage, music, app)
      expect(b.music + b.app + b.other).toBe(usage)
    }
  })
})
