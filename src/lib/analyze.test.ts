import { describe, expect, it, vi } from 'vitest'
import { analyzeFile } from './analyze'
import { buildId3v2, withId3 } from '../test-utils/id3'
import { buildMp3, buildMp4, buildOgg, buildRiff, w32be } from '../test-utils/containers'
import { buildFlac } from '../test-utils/fixtures'

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array.from({ length: 40 }, (_, i) => i)])
const blob = (bytes: Uint8Array<ArrayBuffer>, type = 'audio/mpeg'): Blob => new Blob([bytes], { type })
const text = (s: string): number[] => Array.from(new TextEncoder().encode(s))
const base64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes))
const pictureBlock = (): Uint8Array => Uint8Array.from([...w32be(3), ...w32be(9), ...text('image/png'), ...w32be(0), ...new Array<number>(16).fill(0), ...w32be(PNG.length), ...PNG])
const comments = ['TITLE=Gece Yarısı', 'ARTIST=Şebnem Ferah', 'ALBUM=Aşk', 'ALBUMARTIST=Şebnem', 'DATE=2019-05-04', 'TRACKNUMBER=3', 'TRACKTOTAL=12', 'DISCNUMBER=1/2', 'GENRE=Pop', 'COMPILATION=1', 'REPLAYGAIN_TRACK_GAIN=-7.10 dB', 'LYRICS=[00:01.00]hello']
const expectedMeta = { albumArtist: 'Şebnem', trackNo: 3, trackTotal: 12, discNo: 1, discTotal: 2, year: 2019, genre: 'Pop', compilation: true }

describe('analyzeFile: MP3 (tags from the real ID3 reader, format and duration from the probe)', () => {
  const tag = buildId3v2({
    title: 'Gece Yarısı',
    artist: 'Şebnem Ferah',
    album: 'Aşk',
    albumArtist: 'Şebnem',
    track: '3/12',
    disc: '1/2',
    year: '2019',
    genre: '(13)',
    compilation: '1',
    replayGainTrack: '-6.50 dB',
    lyrics: '[00:01.00]hello',
    picture: { mime: 'image/png', data: PNG },
  })

  it('reads everything a tagged file holds', async () => {
    const a = await analyzeFile(blob(withId3(tag, buildMp3({ frames: 200, xing: { tag: 'Info', lame: { delay: 576, padding: 1000 } } }))))
    expect(a).toMatchObject({ title: 'Gece Yarısı', artist: 'Şebnem Ferah', album: 'Aşk', gainDb: -6.5, lyricsText: '[00:01.00]hello' })
    expect(a.meta).toMatchObject({ albumArtist: 'Şebnem', trackNo: 3, trackTotal: 12, discNo: 1, discTotal: 2, year: 2019, genre: 'Pop', compilation: true })
    expect(a.meta.audio).toMatchObject({ container: 'mp3', codec: 'mp3', sampleRate: 44100, channels: 2, bitrate: 128000, encoderDelay: 576 })
    expect(a.duration).toBeCloseTo((200 * 1152 - 1576) / 44100, 6)
    expect(a.cover?.type).toBe('image/png')
    expect(a.cover?.size).toBe(PNG.length)
  })

  it('copes with a file that has no tag at all', async () => {
    const a = await analyzeFile(blob(buildMp3({ frames: 100, xing: {} })))
    expect(a).toMatchObject({ title: '', artist: '', album: '', gainDb: null, lyricsText: '', cover: null })
    expect(a.meta).toMatchObject({ albumArtist: '', trackNo: 0, year: 0, genre: '', compilation: false })
    expect(a.meta.audio?.container).toBe('mp3')
    expect(a.duration).toBeCloseTo((100 * 1152) / 44100, 6)
  })

  it('reads a bare track number and a plain genre', async () => {
    const a = await analyzeFile(blob(withId3(buildId3v2({ track: '7', genre: 'Hip-Hop', year: '1994' }), buildMp3({ frames: 50 }))))
    expect(a.meta).toMatchObject({ trackNo: 7, trackTotal: 0, genre: 'Hip-Hop', year: 1994 })
  })
})

describe('analyzeFile: FLAC, Ogg and WAV (tags read by the probes, jsmediatags not involved)', () => {
  it('reads a FLAC file with Vorbis comments and cover art', async () => {
    const readTags = vi.fn(async () => ({}))
    const a = await analyzeFile(blob(buildFlac('tone-440', { vorbis: { vendor: 't', comments }, picture: { mime: 'image/png', data: PNG } }), 'audio/flac'), { readTags })
    expect(readTags).not.toHaveBeenCalled()
    expect(a).toMatchObject({ title: 'Gece Yarısı', artist: 'Şebnem Ferah', album: 'Aşk', gainDb: -7.1, lyricsText: '[00:01.00]hello', duration: 4 })
    expect(a.meta).toMatchObject(expectedMeta)
    expect(a.meta.audio).toMatchObject({ container: 'flac', lossless: true, bitDepth: 16, sampleRate: 44100 })
    expect(a.cover?.type).toBe('image/png')
  })

  it.each(['vorbis', 'opus'] as const)('reads %s comments and the cover art in METADATA_BLOCK_PICTURE', async (codec) => {
    const readTags = vi.fn(async () => ({}))
    const all = [...comments, `METADATA_BLOCK_PICTURE=${base64(pictureBlock())}`]
    const a = await analyzeFile(blob(buildOgg({ codec, seconds: 9, comments: all }), 'audio/ogg'), { readTags })
    expect(readTags).not.toHaveBeenCalled()
    expect(a).toMatchObject({ title: 'Gece Yarısı', artist: 'Şebnem Ferah', album: 'Aşk', gainDb: -7.1 })
    expect(a.meta).toMatchObject(expectedMeta)
    expect(a.meta.audio?.container).toBe('ogg')
    expect(a.duration).toBeCloseTo(9, 4)
    expect(a.cover?.size).toBe(PNG.length)
  })

  it('reads the INFO tags of a WAV file', async () => {
    const readTags = vi.fn(async () => ({}))
    const a = await analyzeFile(blob(buildRiff({ frames: 44100, info: { INAM: 'Gece Yarısı', IART: 'Şebnem Ferah', IPRD: 'Aşk', ICRD: '2019-05-04', IGNR: 'Pop', ITRK: '3' } }), 'audio/wav'), { readTags })
    expect(readTags).not.toHaveBeenCalled()
    expect(a).toMatchObject({ title: 'Gece Yarısı', artist: 'Şebnem Ferah', album: 'Aşk', duration: 1 })
    expect(a.meta).toMatchObject({ trackNo: 3, year: 2019, genre: 'Pop' })
    expect(a.meta.audio).toMatchObject({ container: 'wav', codec: 'pcm', lossless: true })
  })
})

describe('analyzeFile: MP4 and unknown containers', () => {
  it('takes the format of an MP4 from the probe and the tags from jsmediatags', async () => {
    const readTags = vi.fn(async () => ({ title: 'From MP4', artist: 'Someone', track: 3, trkn: { data: { track: 3, total: 10 } }, aART: { data: 'The Band' }, cpil: { data: 1 } }))
    const a = await analyzeFile(blob(buildMp4({ seconds: 42.5 }), 'audio/mp4'), { readTags: readTags as never })
    expect(readTags).toHaveBeenCalledTimes(1)
    expect(a).toMatchObject({ title: 'From MP4', artist: 'Someone', duration: 42.5 })
    expect(a.meta).toMatchObject({ trackNo: 3, trackTotal: 10, albumArtist: 'The Band', compilation: true })
    expect(a.meta.audio?.container).toBe('mp4')
  })

  it('falls back to jsmediatags for a container it cannot identify', async () => {
    const readTags = vi.fn(async () => ({ title: 'Mystery', artist: 'Unknown' }))
    const a = await analyzeFile(blob(new Uint8Array(500).fill(7)), { readTags })
    expect(readTags).toHaveBeenCalledTimes(1)
    expect(a).toMatchObject({ title: 'Mystery', artist: 'Unknown', duration: 0 })
    expect(a.meta.audio).toBeNull()
  })
})

describe('analyzeFile: duration fallback', () => {
  const unknown = blob(new Uint8Array(500).fill(7))

  it('asks the media element only when no probe produced a duration', async () => {
    const mediaDuration = vi.fn(async () => 42)
    expect((await analyzeFile(unknown, { readTags: async () => ({}), mediaDuration })).duration).toBe(42)
    expect(mediaDuration).toHaveBeenCalledTimes(1)
    mediaDuration.mockClear()
    await analyzeFile(blob(buildMp3({ frames: 100, xing: {} })), { mediaDuration })
    expect(mediaDuration).not.toHaveBeenCalled()
  })

  it('uses it for a FLAC file whose STREAMINFO has no sample count, keeping the rest of what it knows', async () => {
    const mediaDuration = vi.fn(async () => 3.5)
    const a = await analyzeFile(blob(buildFlac('tone-440', { writeTotalSamples: false }), 'audio/flac'), { mediaDuration })
    expect(a.duration).toBe(3.5)
    expect(a.meta.audio).toMatchObject({ container: 'flac', sampleRate: 44100 })
  })

  it('is 0 when nothing can say', async () => {
    expect((await analyzeFile(unknown, { readTags: async () => ({}), mediaDuration: async () => null })).duration).toBe(0)
    expect((await analyzeFile(unknown, { readTags: async () => ({}) })).duration).toBe(0)
  })
})

describe('analyzeFile: robustness', () => {
  it('never throws, whatever the readers do', async () => {
    const boom = async (): Promise<never> => {
      throw new Error('boom')
    }
    const a = await analyzeFile(blob(new Uint8Array(100)), { readTags: boom, mediaDuration: boom })
    expect(a).toMatchObject({ title: '', artist: '', album: '', duration: 0, gainDb: null, cover: null })
    expect(a.meta.audio).toBeNull()
  })

  it('does not trust sizes in the file: a damaged MP3 still analyses', async () => {
    const bytes = buildMp3({ frames: 100, xing: {} })
    bytes.fill(0xff, 40, 60)
    const a = await analyzeFile(blob(bytes))
    expect(Number.isFinite(a.duration)).toBe(true)
    expect(a.duration).toBeGreaterThanOrEqual(0)
  })
})
