import { describe, expect, it } from 'vitest'
import { toRecord } from './db'
import type { Track, TrackRecord } from '../types'

const file = new File(['audio'], 'a.mp3', { type: 'audio/mpeg' })

const base: TrackRecord = {
  id: 't1',
  key: 'a.mp3|5|1',
  file,
  path: 'Music/Rock',
  coverBlob: null,
  title: 'A',
  artist: 'B',
  album: 'C',
  duration: 12.5,
  lyrics: { synced: true, lines: [{ t: 1, text: 'x' }] },
  gainDb: -3.5, addedAt: 0, plays: 0, lastPlayedAt: null,
}

describe('toRecord', () => {
  it('keeps every persisted field', () => {
    expect(toRecord(base)).toEqual(base)
  })

  it('drops in-memory object URLs and any other extra fields', () => {
    const track: Track & { selected: boolean } = { ...base, url: 'blob:abc', cover: 'blob:def', selected: true }
    const record = toRecord(track)
    expect(Object.keys(record).sort()).toEqual(['addedAt', 'album', 'artist', 'coverBlob', 'duration', 'file', 'gainDb', 'id', 'key', 'lastPlayedAt', 'lyrics', 'path', 'plays', 'title'])
    expect(record).not.toHaveProperty('url')
    expect(record).not.toHaveProperty('cover')
  })

  it('normalizes missing optional values', () => {
    const sparse = { ...base, duration: 0, lyrics: null, gainDb: null, addedAt: 0, plays: 0, lastPlayedAt: null }
    expect(toRecord(sparse)).toMatchObject({ duration: 0, lyrics: null, gainDb: null, addedAt: 0, plays: 0, lastPlayedAt: null, coverBlob: null })
  })

  it('preserves a measured gain of exactly 0 dB (not treated as missing)', () => {
    expect(toRecord({ ...base, gainDb: 0, addedAt: 0, plays: 0, lastPlayedAt: null }).gainDb).toBe(0)
  })

  it('keeps the cover blob', () => {
    const coverBlob = new Blob(['img'], { type: 'image/png' })
    expect(toRecord({ ...base, coverBlob }).coverBlob).toBe(coverBlob)
  })
})
