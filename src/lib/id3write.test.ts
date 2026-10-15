import { beforeEach, describe, expect, it, vi } from 'vitest'
import jsmediatags from 'jsmediatags/dist/jsmediatags.min.js'
import type { Tags } from 'jsmediatags/dist/jsmediatags.min.js'
import { audioOffset, decodeTextBody, isMp3, parseId3v2, removeUnsynchronisation, rewriteId3 } from './id3write'
import { applyTagEdit, cleanField, readCover, resolveFields, sniffImageMime } from './tags'
import { buildId3v2, withId3 } from '../test-utils/id3'
import { replayGainDb } from './metadata'
import type { TrackRecord } from '../types'

/** MPEG-1 Layer III frame headers repeated over filler, enough for sync detection. */
const AUDIO = Uint8Array.from({ length: 4000 }, (_, i) => (i % 417 < 4 ? [0xff, 0xfb, 0x90, 0x00][i % 417]! : (i * 7) & 0x7f))

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8])
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9, 9])

function readTags(bytes: Uint8Array<ArrayBuffer>): Promise<Tags> {
  return new Promise((resolve, reject) => {
    jsmediatags.read(new Blob([bytes]), { onSuccess: (r) => resolve(r.tags ?? {}), onError: reject })
  })
}

const lyricsText = (t: Tags): string => (typeof t.lyrics === 'string' ? t.lyrics : (t.lyrics?.lyrics ?? ''))
const tail = (bytes: Uint8Array, from: number): number[] => Array.from(bytes.subarray(from))
const fileBytes = async (f: Blob): Promise<Uint8Array<ArrayBuffer>> => new Uint8Array(await f.arrayBuffer())

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => 'blob:mock')
  URL.revokeObjectURL = vi.fn()
})

describe('parseId3v2', () => {
  it('returns null without a tag and for invalid headers', () => {
    expect(parseId3v2(AUDIO)).toBeNull()
    expect(parseId3v2(new Uint8Array(4))).toBeNull()
    expect(parseId3v2(Uint8Array.from([0x49, 0x44, 0x33, 9, 0, 0, 0, 0, 0, 0]))).toBeNull() // unknown version
    expect(parseId3v2(Uint8Array.from([0x49, 0x44, 0x33, 3, 0, 0, 0x80, 0, 0, 0]))).toBeNull() // size is not syncsafe
  })

  it('lists the frames of a v2.3 tag and the tag length', () => {
    const tag = buildId3v2({ title: 'T', artist: 'A', replayGainTrack: '-3 dB' })
    const parsed = parseId3v2(withId3(tag, AUDIO))
    expect(parsed?.version).toBe(3)
    expect(parsed?.length).toBe(tag.length)
    expect(parsed?.frames.map((f) => f.id)).toEqual(['TIT2', 'TPE1', 'TXXX'])
  })

  it('stops at padding', () => {
    const tag = buildId3v2({ title: 'T' })
    const padded = new Uint8Array(tag.length + 64)
    padded.set(tag)
    const size = padded.length - 10
    padded.set([(size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f], 6)
    const parsed = parseId3v2(withId3(padded, AUDIO))
    expect(parsed?.frames.map((f) => f.id)).toEqual(['TIT2'])
    expect(parsed?.length).toBe(padded.length)
  })
})

describe('removeUnsynchronisation', () => {
  it('turns FF 00 into FF', () => {
    expect(Array.from(removeUnsynchronisation(Uint8Array.from([1, 0xff, 0, 2, 0xff, 0, 0, 3])))).toEqual([1, 0xff, 2, 0xff, 0, 3])
  })
})

describe('isMp3 / audioOffset', () => {
  it('detects MPEG frame sync, with and without a tag', () => {
    expect(isMp3(AUDIO)).toBe(true)
    const tagged = withId3(buildId3v2({ title: 'x' }), AUDIO)
    expect(isMp3(tagged)).toBe(true)
    expect(audioOffset(tagged)).toBeGreaterThan(0)
    expect(audioOffset(AUDIO)).toBe(0)
  })

  it('rejects other containers', () => {
    expect(isMp3(new TextEncoder().encode('RIFF....WAVEfmt '))).toBe(false)
    expect(isMp3(withId3(buildId3v2({ title: 'x' }), new TextEncoder().encode('fLaC\0\0\0"')))).toBe(false)
    expect(isMp3(new Uint8Array(0))).toBe(false)
  })
})

describe('rewriteId3', () => {
  it('adds a tag to an untagged file without touching the audio', async () => {
    const out = rewriteId3(AUDIO, { title: 'New', artist: 'Band', album: 'LP' })
    expect(await readTags(out)).toMatchObject({ title: 'New', artist: 'Band', album: 'LP' })
    expect(tail(out, audioOffset(out))).toEqual(Array.from(AUDIO))
  })

  it('replaces the edited fields and keeps ReplayGain, lyrics and unedited frames', async () => {
    const src = withId3(buildId3v2({ title: 'Old', artist: 'Old Band', album: 'Old LP', replayGainTrack: '-6.50 dB', lyrics: '[00:01.00]hello', txxx: [['custom', 'kept']] }), AUDIO)
    const out = rewriteId3(src, { title: 'Fresh' })
    const tags = await readTags(out)
    expect(tags).toMatchObject({ title: 'Fresh', artist: 'Old Band', album: 'Old LP' })
    expect(replayGainDb(tags)).toBe(-6.5)
    expect(lyricsText(tags)).toBe('[00:01.00]hello')
    expect(parseId3v2(out)?.frames.filter((f) => f.id === 'TXXX')).toHaveLength(2)
    expect(tail(out, audioOffset(out))).toEqual(Array.from(AUDIO))
  })

  it('removes a field when it is set to an empty string', async () => {
    const src = withId3(buildId3v2({ title: 'T', artist: 'A', album: 'B' }), AUDIO)
    const tags = await readTags(rewriteId3(src, { album: '' }))
    expect(tags.album).toBeUndefined()
    expect(tags).toMatchObject({ title: 'T', artist: 'A' })
  })

  it('round-trips non-latin text through UTF-16', async () => {
    const tags = await readTags(rewriteId3(AUDIO, { title: 'Ünïcode ♪ 音楽', artist: 'Ärtist', album: 'Ω' }))
    expect(tags).toMatchObject({ title: 'Ünïcode ♪ 音楽', artist: 'Ärtist', album: 'Ω' })
  })

  it('replaces the cover, keeps it when untouched and removes it on null', async () => {
    const src = withId3(buildId3v2({ title: 'T', picture: { mime: 'image/jpeg', data: JPEG } }), AUDIO)
    expect(Array.from((await readTags(rewriteId3(src, { title: 'U' }))).picture?.data ?? [])).toEqual(Array.from(JPEG))

    const replaced = await readTags(rewriteId3(src, { picture: { mime: 'image/png', data: PNG } }))
    expect(replaced.picture?.format).toBe('image/png')
    expect(Array.from(replaced.picture?.data ?? [])).toEqual(Array.from(PNG))

    const removed = rewriteId3(src, { picture: null })
    expect((await readTags(removed)).picture).toBeUndefined()
    expect(parseId3v2(removed)?.frames.filter((f) => f.id === 'APIC')).toHaveLength(0)
  })

  it('never leaves two cover frames behind', () => {
    const src = withId3(buildId3v2({ title: 'T', picture: { mime: 'image/jpeg', data: JPEG } }), AUDIO)
    const out = rewriteId3(rewriteId3(src, { picture: { mime: 'image/png', data: PNG } }), { picture: { mime: 'image/jpeg', data: JPEG } })
    expect(parseId3v2(out)?.frames.filter((f) => f.id === 'APIC')).toHaveLength(1)
  })

  it('is stable when applied repeatedly', () => {
    const src = withId3(buildId3v2({ title: 'T', artist: 'A', replayGainTrack: '-1 dB' }), AUDIO)
    const once = rewriteId3(src, { title: 'X' })
    expect(Array.from(rewriteId3(once, { title: 'X' }))).toEqual(Array.from(once))
  })

  describe('other tag layouts', () => {
    /** Wrap raw frame bytes in a tag header of the given version/flags. */
    const tagOf = (version: 2 | 3 | 4, flags: number, body: number[]): number[] => {
      const n = body.length
      return [0x49, 0x44, 0x33, version, 0, flags, (n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f, ...body]
    }
    const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0))
    const frame4 = (id: string, body: number[], flags = 0): number[] => {
      const n = body.length
      return [...ascii(id), (n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f, flags >> 8, flags & 0xff, ...body]
    }
    const frame3 = (id: string, body: number[]): number[] => [...ascii(id), 0, 0, (body.length >> 8) & 0xff, body.length & 0xff, 0, 0, ...body]
    const frame2 = (id: string, body: number[]): number[] => [...ascii(id), 0, (body.length >> 8) & 0xff, body.length & 0xff, ...body]
    const withAudio = (head: number[]): Uint8Array<ArrayBuffer> => Uint8Array.from([...head, ...AUDIO])

    it('keeps v2.4 as v2.4, reading UTF-8 text and syncsafe frame sizes', async () => {
      const long = 'x'.repeat(200) // size > 127 exercises syncsafe encoding
      const src = withAudio(tagOf(4, 0, [...frame4('TIT2', [3, ...ascii('Old')]), ...frame4('TCOM', [3, ...ascii(long)])]))
      const out = rewriteId3(src, { title: 'New' })
      const parsed = parseId3v2(out)
      expect(parsed?.version).toBe(4)
      expect(parsed?.frames.map((f) => f.id).sort()).toEqual(['TCOM', 'TIT2'])
      expect(decodeTextBody(parsed!.frames.find((f) => f.id === 'TCOM')!.body)).toBe(long)
      expect((await readTags(out)).title).toBe('New')
    })

    it('reads past a v2.4 extended header and a footer', () => {
      const ext = [0, 0, 0, 6, 1, 0] // syncsafe size 6, one flag byte, no flags
      const body = [...ext, ...frame4('TPE1', [0, ...ascii('Band')])]
      const src = withAudio([...tagOf(4, 0x40 | 0x10, body), ...new Array<number>(10).fill(0x33)])
      const parsed = parseId3v2(src)
      expect(parsed?.frames.map((f) => f.id)).toEqual(['TPE1'])
      expect(parsed?.length).toBe(10 + body.length + 10)
      const out = rewriteId3(src, { title: 'T' })
      expect(tail(out, audioOffset(out))).toEqual(Array.from(AUDIO))
    })

    it('normalises v2.4 per-frame unsynchronisation and data-length indicators', () => {
      const unsynced = frame4('TXXX', [0, ...ascii('d'), 0, ...ascii('v'), 0xff, 0x00, 0xe0], 0x0002)
      const withLen = frame4('TKEY', [0, 0, 0, 2, 0, ...ascii('C')], 0x0001)
      const frames = parseId3v2(withAudio(tagOf(4, 0, [...unsynced, ...withLen])))!.frames
      expect(Array.from(frames[0]!.body)).toEqual([0, ...ascii('d'), 0, ...ascii('v'), 0xff, 0xe0])
      expect(frames[0]!.flags).toBe(0)
      expect(decodeTextBody(frames[1]!.body)).toBe('C')
    })

    it('un-unsynchronises a whole v2.3 tag', () => {
      const f = frame3('TIT2', [0, 0xff, 0xff, 0xfe])
      const wire: number[] = []
      f.forEach((b, i) => {
        wire.push(b)
        const next = f[i + 1]
        if (b === 0xff && (next === undefined || (next & 0xe0) === 0xe0 || next === 0)) wire.push(0)
      })
      const parsed = parseId3v2(withAudio(tagOf(3, 0x80, wire)))!
      expect(Array.from(parsed.frames[0]!.body)).toEqual([0, 0xff, 0xff, 0xfe])
    })

    it('upgrades v2.2 to v2.3, mapping known frames, converting PIC and dropping unknown ones', async () => {
      const src = withAudio(
        tagOf(2, 0, [
          ...frame2('TT2', [0, ...ascii('Old')]),
          ...frame2('TP1', [0, ...ascii('Band')]),
          ...frame2('TRK', [0, ...ascii('3/9')]),
          ...frame2('ZZZ', [0, 1, 2]),
          ...frame2('PIC', [0, ...ascii('JPG'), 3, 0, ...JPEG]),
        ]),
      )
      const out = rewriteId3(src, { title: 'New' })
      const parsed = parseId3v2(out)!
      expect(parsed.version).toBe(3)
      expect(parsed.frames.map((f) => f.id).sort()).toEqual(['APIC', 'TIT2', 'TPE1', 'TRCK'])
      const tags = await readTags(out)
      expect(tags).toMatchObject({ title: 'New', artist: 'Band' })
      expect(tags.picture?.format).toBe('image/jpeg')
      expect(Array.from(tags.picture?.data ?? [])).toEqual(Array.from(JPEG))
    })

    it('drops compressed or encrypted frames instead of corrupting them', () => {
      const bad = [...ascii('TCOM'), 0, 0, 0, 2, 0x00, 0x80, 0, 65] // v2.3 compression flag
      const src = withAudio(tagOf(3, 0, [...frame3('TIT2', [0, 65]), ...bad]))
      expect(parseId3v2(rewriteId3(src, { artist: 'X' }))!.frames.map((f) => f.id).sort()).toEqual(['TIT2', 'TPE1'])
    })
  })
})

describe('field helpers', () => {
  it('cleanField collapses whitespace, strips control characters and caps the length', () => {
    expect(cleanField('  a \t b\n\u0000c  ')).toBe('a b c')
    expect(cleanField('x'.repeat(1000))).toHaveLength(300)
    expect(cleanField('   ')).toBe('')
  })

  it('resolveFields falls back like an import does', () => {
    expect(resolveFields({ title: ' ', artist: '', album: ' LP ' }, 'My Song.mp3')).toEqual({ title: 'My Song', artist: 'Unknown Artist', album: 'LP' })
  })

  it('sniffImageMime reads magic bytes, not names', () => {
    expect(sniffImageMime(JPEG)).toBe('image/jpeg')
    expect(sniffImageMime(PNG)).toBe('image/png')
    expect(sniffImageMime(Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe('image/gif')
    const webp = new TextEncoder().encode('RIFF\0\0\0\0WEBP')
    expect(sniffImageMime(webp)).toBe('image/webp')
    expect(sniffImageMime(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull()
    expect(sniffImageMime(new Uint8Array(0))).toBeNull()
  })

  it('readCover validates size and content', async () => {
    expect(await readCover(new Blob([]))).toEqual({ ok: false, reason: 'That image is empty' })
    expect(await readCover(new Blob(['not an image'], { type: 'image/png' }))).toMatchObject({ ok: false })
    expect(await readCover(new Blob([new Uint8Array(8 * 1024 * 1024 + 1)]))).toMatchObject({ ok: false, reason: 'That image is larger than 8 MB' })
    expect(await readCover(new Blob([PNG]))).toMatchObject({ ok: true, mime: 'image/png' })
  })
})

describe('applyTagEdit', () => {
  const record = (bytes: Uint8Array<ArrayBuffer>, name = 'song.mp3', type = 'audio/mpeg'): TrackRecord => ({
    id: 't1',
    key: `${name}|${bytes.length}|7`,
    file: new File([bytes], name, { type, lastModified: 7 }),
    path: '',
    coverBlob: new Blob([JPEG], { type: 'image/jpeg' }),
    title: 'Old',
    artist: 'Old Band',
    album: 'Old LP',
    duration: 12,
    lyrics: null,
    gainDb: -2,
  })

  it('updates the library fields and embeds them in an MP3, keeping identity and metadata', async () => {
    const src = record(withId3(buildId3v2({ title: 'Old', replayGainTrack: '-6.50 dB' }), AUDIO))
    const res = await applyTagEdit(src, { title: '  New  Title ', artist: 'Band', album: 'LP' })
    expect(res.embedded).toBe(true)
    expect(res.coverChanged).toBe(false)
    expect(res.record).toMatchObject({ id: 't1', key: src.key, title: 'New Title', artist: 'Band', album: 'LP', duration: 12, gainDb: -2 })
    expect(res.record.file.name).toBe('song.mp3')
    expect(res.record.file.lastModified).toBe(7)
    expect(res.record.coverBlob).toBe(src.coverBlob)
    const tags = await readTags(await fileBytes(res.record.file))
    expect(tags).toMatchObject({ title: 'New Title', artist: 'Band', album: 'LP' })
    expect(replayGainDb(tags)).toBe(-6.5)
  })

  it('replaces the cover after validating it, and can remove it', async () => {
    const withPng = await applyTagEdit(record(AUDIO), { title: 'T', artist: 'A', album: '', cover: new Blob([PNG], { type: 'application/octet-stream' }) })
    expect(withPng.coverChanged).toBe(true)
    expect(withPng.record.coverBlob?.type).toBe('image/png')
    expect((await readTags(await fileBytes(withPng.record.file))).picture?.format).toBe('image/png')

    const none = await applyTagEdit(withPng.record, { title: 'T', artist: 'A', album: '', cover: null })
    expect(none.record.coverBlob).toBeNull()
    expect(none.coverChanged).toBe(true)
    expect((await readTags(await fileBytes(none.record.file))).picture).toBeUndefined()
    expect((await applyTagEdit(none.record, { title: 'T', artist: 'A', album: '', cover: null })).coverChanged).toBe(false)
  })

  it('rejects a bad cover without producing a record', async () => {
    await expect(applyTagEdit(record(AUDIO), { title: 'T', artist: 'A', album: '', cover: new Blob(['nope']) })).rejects.toThrow('JPEG, PNG, GIF or WebP')
  })

  it('shows fallbacks for blank fields but does not write them into the file', async () => {
    const res = await applyTagEdit(record(withId3(buildId3v2({ title: 'x', artist: 'y' }), AUDIO)), { title: '', artist: ' ', album: '' })
    expect(res.record).toMatchObject({ title: 'song', artist: 'Unknown Artist', album: '' })
    const tags = await readTags(await fileBytes(res.record.file))
    expect(tags.title).toBeUndefined()
    expect(tags.artist).toBeUndefined()
  })

  it('leaves non-MP3 audio bytes untouched and only edits the library record', async () => {
    const flac = Uint8Array.from([...new TextEncoder().encode('fLaC'), 0, 0, 0, 34, ...new Array<number>(40).fill(0)])
    const src = record(flac, 'song.flac', 'audio/flac')
    const res = await applyTagEdit(src, { title: 'New', artist: 'A', album: 'B' })
    expect(res.embedded).toBe(false)
    expect(res.record.file).toBe(src.file)
    expect(res.record.title).toBe('New')
  })
})
