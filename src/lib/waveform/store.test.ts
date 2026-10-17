// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { loadPeaks, prunePeaks, readPeaksRecord, savePeaks } from './store'
import type { Peaks } from './types'
import { memoryKv } from '../../test-utils/memorykv'

const peaks = (length = 4): Peaks => ({
  v: 1,
  duration: 12.5,
  length,
  peak: Uint8Array.from({ length }, (_, i) => 200 + i),
  rms: Uint8Array.from({ length }, (_, i) => 100 + i),
})

describe('saving and loading', () => {
  it('gives back what was saved, typed arrays included, for the track it was saved for', async () => {
    const kv = memoryKv()
    await savePeaks(kv, 't1', peaks())
    const loaded = await loadPeaks(kv, 't1')
    expect(loaded).toEqual(peaks())
    expect(loaded && 'peak' in loaded && loaded.peak).toBeInstanceOf(Uint8Array)
    expect(await loadPeaks(kv, 'other')).toBeNull()
  })

  it('keeps the reason a track has no waveform, so a file the browser cannot decode is not tried on every play', async () => {
    const kv = memoryKv()
    await savePeaks(kv, 'a', { v: 1, none: 'unsupported' })
    await savePeaks(kv, 'b', { v: 1, none: 'too-long' })
    expect(await loadPeaks(kv, 'a')).toEqual({ v: 1, none: 'unsupported' })
    expect(await loadPeaks(kv, 'b')).toEqual({ v: 1, none: 'too-long' })
  })

  it('keeps each track under a key of its own in the `meta` store, in the "peaks:" family the cleanup knows', async () => {
    const kv = memoryKv()
    await savePeaks(kv, 'abc', peaks())
    expect([...kv.data.keys()]).toEqual(['peaks:abc'])
  })

  it('does not fail the player when the disk is full or blocked: a waveform is only a cache', async () => {
    const kv = memoryKv()
    kv.fail.set = true
    await expect(savePeaks(kv, 't1', peaks())).resolves.toBeUndefined()
    kv.fail.set = false
    kv.fail.get = true
    await expect(loadPeaks(kv, 't1')).resolves.toBeNull()
  })
})

describe('readPeaksRecord', () => {
  const ok = peaks()
  const bad: [string, unknown][] = [
    ['nothing', undefined],
    ['null', null],
    ['a number', 7],
    ['an old layout (v 2 means the maths changed: compute again)', { ...ok, v: 2 }],
    ['no version', { ...ok, v: undefined }],
    ['a "none" reason it does not know', { v: 1, none: 'sad' }],
    ['a duration that is not finite', { ...ok, duration: Number.NaN }],
    ['a negative duration', { ...ok, duration: -1 }],
    ['a length that is not a whole number', { ...ok, length: 4.5 }],
    ['a length of zero', { ...ok, length: 0, peak: new Uint8Array(0), rms: new Uint8Array(0) }],
    ['more slices than any seek bar could draw', { ...ok, length: 5000, peak: new Uint8Array(5000), rms: new Uint8Array(5000) }],
    ['a peak list of another length', { ...ok, peak: new Uint8Array(3) }],
    ['an rms list of another length', { ...ok, rms: new Uint8Array(5) }],
    ['plain arrays, as JSON would have given back', { ...ok, peak: [...ok.peak], rms: [...ok.rms] }],
  ]

  it('accepts exactly what this version writes', () => {
    expect(readPeaksRecord(ok)).toEqual(ok)
    expect(readPeaksRecord({ v: 1, none: 'too-long' })).toEqual({ v: 1, none: 'too-long' })
  })

  it.each(bad)('reads %s as "compute it again", never as a waveform', (_name, value) => {
    expect(readPeaksRecord(value)).toBeNull()
  })

  it('drops any extra fields instead of carrying them along', () => {
    expect(Object.keys(readPeaksRecord({ ...ok, extra: 'x' }) ?? {}).sort()).toEqual(['duration', 'length', 'peak', 'rms', 'v'])
  })
})

describe('prunePeaks', () => {
  it('deletes the waveforms of tracks that are no longer in the library, and only those', async () => {
    const kv = memoryKv({ 'peaks:keep': peaks(), 'peaks:gone': peaks(), 'peaks:gone2': { v: 1, none: 'unsupported' } })
    expect(await prunePeaks(kv, new Set(['keep']))).toBe(2)
    expect([...kv.data.keys()]).toEqual(['peaks:keep'])
  })

  it('leaves everything else in the store alone: the order, the playlists, other caches', async () => {
    const kv = memoryKv({ order: ['a'], playlists: [], 'chapters:gone': {}, 'listen:gone': {}, 'peaks:gone': peaks(), 'peaksfoo': 1 })
    await prunePeaks(kv, new Set())
    expect([...kv.data.keys()].sort()).toEqual(['chapters:gone', 'listen:gone', 'order', 'peaksfoo', 'playlists'])
  })

  it('has nothing to do for an empty store', async () => {
    expect(await prunePeaks(memoryKv(), new Set(['a']))).toBe(0)
  })
})
