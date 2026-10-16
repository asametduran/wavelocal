import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tags } from 'jsmediatags/dist/jsmediatags.min.js'

// Tag parsing is replaced by a lookup table so the pairing logic can be tested deterministically.
const tagTable = vi.hoisted(() => new Map<string, Record<string, unknown>>())
vi.mock('jsmediatags/dist/jsmediatags.min.js', () => ({
  default: {
    read: (file: File, cb: { onSuccess: (r: { tags: Record<string, unknown> }) => void; onError: (e: unknown) => void }) => {
      const tags = tagTable.get(file.name)
      if (tags) cb.onSuccess({ tags })
      else cb.onError(new Error('no tags'))
    },
  },
}))

import { buildTrack, fileKey, filesToTracks, isAudioFile, isLrcFile, norm, replayGainDb, revokeTrack } from './metadata'

const audio = (name: string, type = 'audio/mpeg', lastModified = 1) => new File(['x'], name, { type, lastModified })
const lrc = (name: string, body: string) => new File([body], name, { type: 'text/plain' })

beforeEach(() => {
  tagTable.clear()
  let n = 0
  URL.createObjectURL = vi.fn(() => `blob:mock-${n++}`)
  URL.revokeObjectURL = vi.fn()
})

describe('file classification', () => {
  it.each([
    ['song.mp3', '', true],
    ['SONG.FLAC', '', true],
    ['voice.opus', '', true],
    ['noext', 'audio/ogg', true],
    ['notes.txt', 'text/plain', false],
    ['cover.jpg', 'image/jpeg', false],
    ['song.lrc', 'text/plain', false],
  ])('isAudioFile(%s, %j) is %s', (name, type, expected) => {
    expect(isAudioFile(audio(name, type))).toBe(expected)
  })

  it('recognises .lrc files case-insensitively', () => {
    expect(isLrcFile(lrc('a.lrc', ''))).toBe(true)
    expect(isLrcFile(lrc('A.LRC', ''))).toBe(true)
    expect(isLrcFile(lrc('a.txt', ''))).toBe(false)
  })

  it('norm strips the extension, trims and lowercases', () => {
    expect(norm('Song.MP3')).toBe('song')
    expect(norm(' My Song .lrc')).toBe('my song')
    expect(norm('a.b.mp3')).toBe('a.b')
  })

  it('fileKey identifies a file by name, size and modified time', () => {
    expect(fileKey(audio('a.mp3', '', 7))).toBe('a.mp3|1|7')
    expect(fileKey(audio('a.mp3', '', 7))).not.toBe(fileKey(audio('a.mp3', '', 8)))
  })
})

describe('replayGainDb', () => {
  const frame = (description: string, value: string) => ({ data: { user_description: description, data: value } })

  it('reads the track gain from a TXXX frame', () => {
    expect(replayGainDb({ TXXX: frame('REPLAYGAIN_TRACK_GAIN', '-6.50 dB') })).toBe(-6.5)
  })

  it('accepts a flat (unwrapped) frame payload', () => {
    expect(replayGainDb({ TXXX: { user_description: 'replaygain_track_gain', data: '+3.2 dB' } })).toBe(3.2)
  })

  it('prefers track gain over album gain, in any frame order', () => {
    const tags: Tags = { TXXX: [frame('replaygain_album_gain', '-9 dB'), frame('replaygain_track_gain', '-4 dB')] }
    expect(replayGainDb(tags)).toBe(-4)
  })

  it('falls back to album gain', () => {
    expect(replayGainDb({ TXXX: [frame('replaygain_album_gain', '-9.1 dB')] })).toBe(-9.1)
  })

  it('tolerates NUL padding and odd casing in the description', () => {
    expect(replayGainDb({ TXXX: frame('  ReplayGain_Track_Gain\0', '-2 dB') })).toBe(-2)
  })

  it('ignores unrelated TXXX frames', () => {
    expect(replayGainDb({ TXXX: [frame('replaygain_track_peak', '0.98'), frame('MOOD', 'happy')] })).toBeNull()
  })

  it('clamps extreme values to +-12 dB', () => {
    expect(replayGainDb({ TXXX: frame('replaygain_track_gain', '+20 dB') })).toBe(12)
    expect(replayGainDb({ TXXX: frame('replaygain_track_gain', '-20 dB') })).toBe(-12)
  })

  it('rounds to one decimal', () => {
    expect(replayGainDb({ TXXX: frame('replaygain_track_gain', '-6.54 dB') })).toBe(-6.5)
  })

  it.each([[undefined], [null], [{}], [{ TXXX: [] }], [{ TXXX: frame('replaygain_track_gain', 'n/a') }]])('returns null for %j', (tags) => {
    expect(replayGainDb(tags as Tags | null | undefined)).toBeNull()
  })
})

describe('filesToTracks', () => {
  it('builds a track from a file without readable tags', async () => {
    const f = audio('My Song.mp3')
    const { tracks, orphanLrc } = await filesToTracks([f])
    expect(orphanLrc).toEqual([])
    expect(tracks).toHaveLength(1)
    expect(tracks[0]).toMatchObject({ title: 'My Song', artist: 'Unknown Artist', album: '', duration: 0, lyrics: null, gainDb: null, addedAt: expect.any(Number), plays: 0, lastPlayedAt: null, cover: null, key: fileKey(f) })
    expect(tracks[0]?.id).toMatch(/^t[a-z0-9]+$/)
    expect(tracks[0]?.url).toMatch(/^blob:mock-/)
  })

  it('reads title, artist, album, cover and ReplayGain from tags', async () => {
    tagTable.set('x.mp3', {
      title: ' Real Title ',
      artist: 'Real Artist',
      album: ' Album ',
      picture: { format: 'image/png', data: [137, 80, 78, 71] },
      TXXX: { data: { user_description: 'replaygain_track_gain', data: '-4.2 dB' } },
    })
    const [t] = (await filesToTracks([audio('x.mp3')])).tracks
    expect(t).toMatchObject({ title: 'Real Title', artist: 'Real Artist', album: 'Album', gainDb: -4.2, addedAt: expect.any(Number), plays: 0, lastPlayedAt: null })
    expect(t?.coverBlob?.type).toBe('image/png')
    expect(t?.cover).toMatch(/^blob:mock-/)
  })

  it('pairs an .lrc with the audio file of the same name', async () => {
    const { tracks, orphanLrc } = await filesToTracks([audio('Song.mp3'), lrc('song.lrc', '[00:01.00]hi')])
    expect(tracks[0]?.lyrics).toEqual({ synced: true, lines: [{ t: 1, text: 'hi' }] })
    expect(orphanLrc).toEqual([])
  })

  it('pairs an .lrc by the track title tag', async () => {
    tagTable.set('a.mp3', { title: 'Hello World', artist: 'X' })
    const { tracks } = await filesToTracks([audio('a.mp3'), lrc('hello world.lrc', '[00:02.00]yo')])
    expect(tracks[0]?.lyrics?.lines[0]?.text).toBe('yo')
  })

  it('pairs an .lrc named "artist - title"', async () => {
    tagTable.set('a.mp3', { title: 'Hello', artist: 'Band' })
    const { tracks } = await filesToTracks([audio('a.mp3'), lrc('Band - Hello.lrc', '[00:02.00]yo')])
    expect(tracks[0]?.lyrics?.lines[0]?.text).toBe('yo')
  })

  it('falls back to lyrics embedded in the tags', async () => {
    tagTable.set('a.mp3', { lyrics: { lyrics: '[00:01.00]embedded' } })
    tagTable.set('b.mp3', { lyrics: '[00:01.00]plain string' })
    const { tracks } = await filesToTracks([audio('a.mp3'), audio('b.mp3')])
    expect(tracks.map((t) => t.lyrics?.lines[0]?.text)).toEqual(['embedded', 'plain string'])
  })

  it('prefers a sidecar .lrc over embedded lyrics', async () => {
    tagTable.set('a.mp3', { lyrics: '[00:01.00]embedded' })
    const { tracks } = await filesToTracks([audio('a.mp3'), lrc('a.lrc', '[00:01.00]sidecar')])
    expect(tracks[0]?.lyrics?.lines[0]?.text).toBe('sidecar')
  })

  it('returns .lrc files that matched nothing so the caller can attach them later', async () => {
    const { tracks, orphanLrc } = await filesToTracks([audio('a.mp3'), lrc('other.lrc', '[00:01.00]x')])
    expect(tracks[0]?.lyrics).toBeNull()
    expect(orphanLrc.map((o) => o.name)).toEqual(['other.lrc'])
    expect(orphanLrc[0]?.lyrics.synced).toBe(true)
  })

  it('returns orphan .lrc files even when no audio is imported', async () => {
    const { tracks, orphanLrc } = await filesToTracks([lrc('song.lrc', '[00:01.00]x')])
    expect(tracks).toEqual([])
    expect(orphanLrc).toHaveLength(1)
  })

  it('ignores .lrc files with no usable content', async () => {
    const { orphanLrc } = await filesToTracks([lrc('empty.lrc', '  \n ')])
    expect(orphanLrc).toEqual([])
  })

  it('skips files already in the library and non-audio files', async () => {
    const dup = audio('a.mp3')
    const { tracks } = await filesToTracks([dup, audio('b.mp3'), audio('notes.txt', 'text/plain')], new Set([fileKey(dup)]))
    expect(tracks.map((t) => t.title)).toEqual(['b'])
  })

  it('imports in natural filename order', async () => {
    const files = ['track10.mp3', 'track2.mp3', 'track1.mp3'].map((n) => audio(n))
    const { tracks } = await filesToTracks(files)
    expect(tracks.map((t) => t.title)).toEqual(['track1', 'track2', 'track10'])
  })

  it('accepts a FileList-like object', async () => {
    const list = { 0: audio('a.mp3'), length: 1 } as ArrayLike<File>
    expect((await filesToTracks(list)).tracks).toHaveLength(1)
  })

  it('gives every imported track a unique id', async () => {
    const { tracks } = await filesToTracks(Array.from({ length: 50 }, (_, i) => audio(`s${i}.mp3`)))
    expect(new Set(tracks.map((t) => t.id)).size).toBe(50)
  })
})

describe('folder paths', () => {
  const inFolder = (name: string, path: string) => Object.defineProperty(audio(name), 'webkitRelativePath', { value: path })

  it('records the folder a file was picked from', async () => {
    const { tracks } = await filesToTracks([inFolder('a.mp3', 'Music/Rock/a.mp3'), inFolder('b.mp3', 'Music/b.mp3')])
    expect(tracks.map((t) => [t.file.name, t.path])).toEqual([
      ['a.mp3', 'Music/Rock'],
      ['b.mp3', 'Music'],
    ])
  })

  it('leaves individually picked files without a folder', async () => {
    const { tracks } = await filesToTracks([audio('a.mp3')])
    expect(tracks[0]?.path).toBe('')
  })

  it('does not let a hostile relative path escape the root', async () => {
    const { tracks } = await filesToTracks([inFolder('a.mp3', '../../x/a.mp3')])
    expect(tracks[0]?.path).toBe('x')
  })

  it('treats records saved before the folder view as loose files', () => {
    const legacy = { id: 't1', key: 'k', file: audio('a.mp3'), coverBlob: null, title: 'A', artist: 'B', album: '', duration: 0, lyrics: null, gainDb: null }
    // @ts-expect-error old IndexedDB rows have no `path`, dates or play counts
    const track = buildTrack(legacy)
    expect(track.path).toBe('')
    expect(track).toMatchObject({ addedAt: 0, plays: 0, lastPlayedAt: null })
  })
})

describe('buildTrack / revokeTrack', () => {
  const rec = {
    id: 't1',
    key: 'k',
    file: audio('a.mp3'),
    path: '',
    coverBlob: null,
    title: 'A',
    artist: 'B',
    album: '',
    duration: 0,
    lyrics: null,
    gainDb: null, addedAt: 0, plays: 0, lastPlayedAt: null,
  }

  it('adds an object URL for the audio and none for missing artwork', () => {
    const t = buildTrack(rec)
    expect(t.url).toMatch(/^blob:mock-/)
    expect(t.cover).toBeNull()
  })

  it('adds an object URL for artwork when present', () => {
    expect(buildTrack({ ...rec, coverBlob: new Blob(['i']) }).cover).toMatch(/^blob:mock-/)
  })

  it('mints object URLs only when they are first read, and keeps them stable', () => {
    const t = buildTrack({ ...rec, coverBlob: new Blob(['i']) })
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    const url = t.url
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1)
    expect(t.url).toBe(url)
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1)
    expect(t.cover).not.toBe(url)
    expect(URL.createObjectURL).toHaveBeenCalledTimes(2)
  })

  it('building thousands of tracks registers no object URLs until they are shown', () => {
    for (let i = 0; i < 5000; i++) buildTrack({ ...rec, id: `t${i}`, coverBlob: new Blob(['i']) })
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  it('revoking a never-read track revokes nothing', () => {
    revokeTrack(buildTrack({ ...rec, coverBlob: new Blob(['i']) }))
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
  })

  it('revokes exactly the URLs a lazy track created', () => {
    const t = buildTrack({ ...rec, coverBlob: new Blob(['i']) })
    const url = t.url
    revokeTrack(t)
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1)
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(url)
  })

  it('a spread copy is a plain object that revokes the URLs it captured', () => {
    const copy = { ...buildTrack({ ...rec, coverBlob: new Blob(['i']) }) }
    expect(copy.url).toMatch(/^blob:mock-/)
    revokeTrack(copy)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(copy.url)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(copy.cover)
  })

  it('revokes both URLs', () => {
    revokeTrack({ url: 'blob:a', cover: 'blob:b' })
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:a')
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:b')
  })

  it('revokes only the audio URL when there is no artwork', () => {
    revokeTrack({ url: 'blob:a', cover: null })
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1)
  })
})
