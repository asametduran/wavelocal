import { beforeEach, describe, expect, it, vi } from 'vitest'
import jsmediatags from 'jsmediatags/dist/jsmediatags.min.js'
import type { Tags } from 'jsmediatags/dist/jsmediatags.min.js'
import { filesToTracks, replayGainDb } from '../lib/metadata'
import { parseLrc } from '../lib/lrc'
import { buildId3v2, withId3 } from './id3'
import { fixtureFile, lrcText } from './fixtures'
import { buildFixture } from './fixtures'

/** Parse tag bytes with the real jsmediatags (no mocks) to prove the app reads genuine ID3 data. */
function readTags(bytes: Uint8Array<ArrayBuffer>): Promise<Tags> {
  return new Promise((resolve, reject) => {
    jsmediatags.read(new Blob([bytes]), { onSuccess: (r) => resolve(r.tags ?? {}), onError: reject })
  })
}

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => 'blob:mock')
  URL.revokeObjectURL = vi.fn()
})

describe('buildId3v2', () => {
  it('writes a valid ID3v2.3 header whose syncsafe size matches the frames', () => {
    const tag = buildId3v2({ title: 'T' })
    expect(String.fromCharCode(...tag.slice(0, 3))).toBe('ID3')
    expect([tag[3], tag[4], tag[5]]).toEqual([3, 0, 0])
    const size = (tag[6]! << 21) | (tag[7]! << 14) | (tag[8]! << 7) | tag[9]!
    expect(size).toBe(tag.length - 10)
  })

  it('round-trips text fields through the real tag reader', async () => {
    const tags = await readTags(buildId3v2({ title: 'My Title', artist: 'The Band', album: 'First Album' }))
    expect(tags).toMatchObject({ title: 'My Title', artist: 'The Band', album: 'First Album' })
  })

  it('round-trips non-latin text via UTF-16', async () => {
    const tags = await readTags(buildId3v2({ title: 'Ünïcode ♪ 音楽', artist: 'Ärtist' }))
    expect(tags.title).toBe('Ünïcode ♪ 音楽')
    expect(tags.artist).toBe('Ärtist')
  })

  it('carries embedded lyrics', async () => {
    const lrc = lrcText([
      [1, 'first line'],
      [4.5, 'second line'],
    ])
    const tags = await readTags(buildId3v2({ title: 'x', lyrics: lrc }))
    const text = typeof tags.lyrics === 'string' ? tags.lyrics : tags.lyrics?.lyrics
    expect(parseLrc(text)?.lines).toEqual([
      { t: 1, text: 'first line' },
      { t: 4.5, text: 'second line' },
    ])
  })

  it('carries cover art', async () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])
    const tags = await readTags(buildId3v2({ title: 'x', picture: { mime: 'image/png', data: png } }))
    expect(tags.picture?.format).toBe('image/png')
    expect(Array.from(tags.picture?.data ?? [])).toEqual([...png])
  })
})

describe('ReplayGain from real ID3 bytes', () => {
  it('reads the track gain', async () => {
    expect(replayGainDb(await readTags(buildId3v2({ replayGainTrack: '-6.50 dB' })))).toBe(-6.5)
  })

  it('prefers track gain over album gain', async () => {
    const tags = await readTags(buildId3v2({ replayGainAlbum: '-9.00 dB', replayGainTrack: '-3.26 dB' }))
    expect(replayGainDb(tags)).toBe(-3.3) // rounded to one decimal
  })

  it('falls back to album gain', async () => {
    expect(replayGainDb(await readTags(buildId3v2({ replayGainAlbum: '+2.4 dB' })))).toBe(2.4)
  })

  it('finds the gain among other TXXX frames', async () => {
    const tags = await readTags(buildId3v2({ txxx: [['MOOD', 'calm'], ['replaygain_track_peak', '0.9']], replayGainTrack: '-1.0 dB' }))
    expect(replayGainDb(tags)).toBe(-1)
  })

  it('clamps absurd values', async () => {
    expect(replayGainDb(await readTags(buildId3v2({ replayGainTrack: '-40 dB' })))).toBe(-12)
  })

  it('is null when no gain tag exists', async () => {
    expect(replayGainDb(await readTags(buildId3v2({ title: 'no gain here' })))).toBeNull()
  })
})

describe('import of a tagged file (unmocked)', () => {
  it('turns ID3 tags into track fields, lyrics, cover and gain', async () => {
    const tag = buildId3v2({
      title: 'Tagged Song',
      artist: 'Some Artist',
      album: 'Some Album',
      replayGainTrack: '-4.2 dB',
      lyrics: lrcText([[0.5, 'la la']]),
      picture: { mime: 'image/png', data: Uint8Array.from([1, 2, 3, 4, 5]) },
    })
    const bytes = withId3(tag, buildFixture('tone-440').bytes)
    const file = new File([bytes], 'tagged.mp3', { type: 'audio/mpeg' })

    const { tracks } = await filesToTracks([file])
    expect(tracks).toHaveLength(1)
    const t = tracks[0]!
    expect(t).toMatchObject({ title: 'Tagged Song', artist: 'Some Artist', album: 'Some Album', gainDb: -4.2 })
    expect(t.lyrics).toEqual({ synced: true, lines: [{ t: 0.5, text: 'la la' }] })
    expect(t.coverBlob?.size).toBe(5)
    expect(t.coverBlob?.type).toBe('image/png')
  })

  it('falls back to the filename for a plain WAV with no tags', async () => {
    const { tracks } = await filesToTracks([fixtureFile('tone-440')])
    expect(tracks[0]).toMatchObject({ title: 'tone-440', artist: 'Unknown Artist', lyrics: null, gainDb: null })
  })
})
