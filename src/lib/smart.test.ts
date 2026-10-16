import { describe, expect, it } from 'vitest'
import type { Track } from '../types'
import { SMART_LIMIT, SMART_LISTS, describeAge, isSmartId, playsLabel, smartCounts, smartDetail, smartList, smartTracks } from './smart'

const NOW = Date.UTC(2026, 5, 15, 12)
const DAY = 86_400_000

function track(id: string, over: Partial<Track> = {}): Track {
  return {
    id,
    key: id,
    file: new File([''], `${id}.mp3`),
    path: '',
    coverBlob: null,
    title: id,
    artist: 'A',
    album: '',
    duration: 100,
    lyrics: null,
    gainDb: null,
    addedAt: 0,
    plays: 0,
    lastPlayedAt: null,
    url: '',
    cover: null,
    ...over,
  }
}
const ids = (l: Track[]) => l.map((t) => t.id)

describe('smart list registry', () => {
  it('knows its own ids and nothing else', () => {
    for (const l of SMART_LISTS) {
      expect(isSmartId(l.id)).toBe(true)
      expect(smartList(l.id)).toBe(l)
    }
    expect(isSmartId('all')).toBe(false)
    expect(isSmartId('smart:nope')).toBe(false)
    expect(isSmartId('p1')).toBe(false)
    expect(smartList('all')).toBeNull()
  })
})

describe('recently added', () => {
  it('lists the newest first', () => {
    const l = [track('a', { addedAt: 100 }), track('b', { addedAt: 300 }), track('c', { addedAt: 200 })]
    expect(ids(smartTracks('recent', l))).toEqual(['b', 'c', 'a'])
  })
  it('keeps tracks from one import in reverse library order', () => {
    const l = [track('a', { addedAt: 5 }), track('b', { addedAt: 5 }), track('c', { addedAt: 5 })]
    expect(ids(smartTracks('recent', l))).toEqual(['c', 'b', 'a'])
  })
  it('puts a library from before dates were recorded in reverse import order, below dated tracks', () => {
    const l = [track('old1'), track('old2'), track('old3'), track('new', { addedAt: 9 })]
    expect(ids(smartTracks('recent', l))).toEqual(['new', 'old3', 'old2', 'old1'])
  })
  it('is capped', () => {
    const l = Array.from({ length: SMART_LIMIT + 40 }, (_, i) => track(`t${i}`, { addedAt: i + 1 }))
    const r = smartTracks('recent', l)
    expect(r).toHaveLength(SMART_LIMIT)
    expect(r[0]?.id).toBe(`t${SMART_LIMIT + 39}`)
  })
  it('does not reorder the library it was given', () => {
    const l = [track('a', { addedAt: 1 }), track('b', { addedAt: 2 })]
    smartTracks('recent', l)
    expect(ids(l)).toEqual(['a', 'b'])
  })
})

describe('most played', () => {
  it('sorts by plays, then by who was played most recently, then library order', () => {
    const l = [
      track('a', { plays: 2, lastPlayedAt: 10 }),
      track('b', { plays: 5, lastPlayedAt: 5 }),
      track('c', { plays: 2, lastPlayedAt: 20 }),
      track('d', { plays: 2, lastPlayedAt: 20 }),
      track('never'),
    ]
    expect(ids(smartTracks('top', l))).toEqual(['b', 'c', 'd', 'a'])
  })
  it('is empty before anything has been played', () => {
    expect(smartTracks('top', [track('a'), track('b')])).toEqual([])
  })
})

describe('recently played', () => {
  it('lists by last played, newest first, and skips unplayed tracks', () => {
    const l = [track('a', { lastPlayedAt: 1 }), track('b'), track('c', { lastPlayedAt: 3 }), track('d', { lastPlayedAt: 2 })]
    expect(ids(smartTracks('played', l))).toEqual(['c', 'd', 'a'])
  })
})

describe('never played', () => {
  it('keeps library order and drops anything with a play', () => {
    const l = [track('a'), track('b', { plays: 1 }), track('c'), track('d', { plays: 0 })]
    expect(ids(smartTracks('never', l))).toEqual(['a', 'c', 'd'])
  })
  it('is not capped', () => {
    const l = Array.from({ length: SMART_LIMIT + 50 }, (_, i) => track(`t${i}`))
    expect(smartTracks('never', l)).toHaveLength(SMART_LIMIT + 50)
  })
})

describe('smartCounts', () => {
  it('matches what each list would contain', () => {
    const l = [track('a', { plays: 3, lastPlayedAt: 1, addedAt: 1 }), track('b'), track('c', { plays: 1, lastPlayedAt: 2 }), track('d')]
    const counts = smartCounts(l)
    expect(counts).toEqual({ recent: 4, top: 2, played: 2, never: 2 })
    expect(counts.top).toBe(smartTracks('top', l).length)
    expect(counts.never).toBe(smartTracks('never', l).length)
  })
  it('caps the capped lists', () => {
    const l = Array.from({ length: SMART_LIMIT + 5 }, (_, i) => track(`t${i}`, { plays: 1, lastPlayedAt: i + 1 }))
    expect(smartCounts(l)).toMatchObject({ recent: SMART_LIMIT, top: SMART_LIMIT, played: SMART_LIMIT, never: 0 })
  })
})

describe('describeAge', () => {
  it('speaks in days, then weeks, then a date', () => {
    expect(describeAge(NOW - 3_600_000, NOW)).toBe('today')
    expect(describeAge(NOW - DAY - 1000, NOW)).toBe('yesterday')
    expect(describeAge(NOW - 5 * DAY, NOW)).toBe('5 days ago')
    expect(describeAge(NOW - 21 * DAY, NOW)).toBe('3 weeks ago')
    expect(describeAge(NOW - 200 * DAY, NOW)).toMatch(/\d{4}/)
  })
  it('says nothing about an unknown or future time', () => {
    expect(describeAge(0, NOW)).toBeNull()
    expect(describeAge(NOW + 5 * DAY, NOW)).toBeNull()
  })
})

describe('row details', () => {
  it('shows what each list is about', () => {
    expect(smartDetail('recent', track('a', { addedAt: NOW - 2 * DAY }), NOW)).toBe('added 2 days ago')
    expect(smartDetail('recent', track('a'), NOW)).toBeNull()
    expect(smartDetail('top', track('a', { plays: 1 }), NOW)).toBe('1 play')
    expect(smartDetail('top', track('a', { plays: 12 }), NOW)).toBe('12 plays')
    expect(smartDetail('played', track('a', { lastPlayedAt: NOW - 1000 }), NOW)).toBe('played today')
    expect(smartDetail('never', track('a'), NOW)).toBeNull()
  })
  it('pluralises', () => {
    expect(playsLabel(0)).toBe('0 plays')
    expect(playsLabel(1)).toBe('1 play')
    expect(playsLabel(2)).toBe('2 plays')
  })
})
