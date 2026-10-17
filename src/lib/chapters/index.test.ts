// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { containerFromHead, readChapters } from './index'
import { blankFormat } from '../audio/probe/types'
import type { AudioContainer, AudioFormat } from '../audio/probe/types'
import { buildChapterTag, buildMp4WithChpl, buildMp4WithTextChapters } from '../../test-utils/chapters'
import { ascii, buildMp3, buildOgg, cat } from '../../test-utils/containers'
import { withId3 } from '../../test-utils/id3'
import { encodeFlac, floatToInt } from '../../test-utils/flac-encoder'
import { encodeWav } from '../../test-utils/wav'

const format = (container: AudioContainer): AudioFormat => ({ ...blankFormat(container), sampleRate: 44100, channels: 2 })
const blob = (bytes: Uint8Array<ArrayBuffer>) => new Blob([bytes])

const SPEC = [
  { startMs: 0, title: 'Opening' },
  { startMs: 90_000, title: 'Middle' },
  { startMs: 600_000, title: 'End' },
]
const WANT = [
  { start: 0, end: 90, title: 'Opening' },
  { start: 90, end: 600, title: 'Middle' },
  { start: 600, end: 1000, title: 'End' },
]
const COMMENTS = ['CHAPTER001=00:00:00', 'CHAPTER001NAME=Opening', 'CHAPTER002=00:01:30', 'CHAPTER002NAME=Middle', 'CHAPTER003=00:10:00', 'CHAPTER003NAME=End']

describe('readChapters', () => {
  it('reads the ID3 chapters of an MP3 and ends the last one with the file', async () => {
    const mp3 = withId3(buildChapterTag(SPEC), buildMp3({ frames: 60 }))
    expect(await readChapters(blob(mp3), format('mp3'), 1000)).toEqual(WANT)
  })

  it('reads the chapters of an M4B in either of the ways it keeps them', async () => {
    const book = [{ start: 0, title: 'Opening' }, { start: 90, title: 'Middle' }, { start: 600, title: 'End' }]
    expect(await readChapters(blob(buildMp4WithChpl(book, { seconds: 1000 })), format('mp4'), 1000)).toEqual(WANT)
    expect(await readChapters(blob(buildMp4WithTextChapters(book, { seconds: 1000 })), format('mp4'), 1000)).toEqual(WANT)
  })

  it('reads the chapter comments of Ogg Vorbis, Opus and FLAC', async () => {
    expect(await readChapters(blob(buildOgg({ codec: 'vorbis', seconds: 1000, comments: COMMENTS })), format('ogg'), 1000)).toEqual(WANT)
    expect(await readChapters(blob(buildOgg({ codec: 'opus', seconds: 1000, comments: COMMENTS })), format('ogg'), 1000)).toEqual(WANT)
    const flac = encodeFlac([floatToInt(new Float32Array(8000), 16)], { sampleRate: 8000, bitsPerSample: 16, vorbis: { vendor: 'test', comments: COMMENTS } })
    expect(await readChapters(blob(flac), format('flac'), 1000)).toEqual(WANT)
  })

  it('finds the chapters of a FLAC file that carries an ID3 tag instead of Vorbis comments', async () => {
    const flac = encodeFlac([floatToInt(new Float32Array(8000), 16)], { sampleRate: 8000, bitsPerSample: 16 })
    expect(await readChapters(blob(withId3(buildChapterTag(SPEC), flac)), format('flac'), 1000)).toEqual(WANT)
  })

  it('looks at the first bytes when the library did not record the container (a track imported long ago)', async () => {
    expect(await readChapters(blob(withId3(buildChapterTag(SPEC), buildMp3({ frames: 60 }))), null, 1000)).toEqual(WANT)
    expect(await readChapters(blob(buildMp4WithChpl([{ start: 0, title: 'Opening' }, { start: 90, title: 'Middle' }, { start: 600, title: 'End' }], { seconds: 1000 })), null, 1000)).toEqual(WANT)
    expect(await readChapters(blob(buildOgg({ codec: 'vorbis', seconds: 1000, comments: COMMENTS })), null, 1000)).toEqual(WANT)
  })

  it('cleans what the file says: unreachable chapters go, titles are tidied, untitled ones are named', async () => {
    // UTF-16 titles, since the direction override in the second one does not exist in Latin-1
    const odd = buildChapterTag([{ startMs: 0 }, { startMs: 5000, title: '  Tidy ‮ up  ' }, { startMs: 9_999_000, title: 'Beyond the end' }], { encoding: 1 })
    expect(await readChapters(blob(withId3(odd, buildMp3({ frames: 60 }))), format('mp3'), 100)).toEqual([
      { start: 0, end: 5, title: 'Chapter 1' },
      { start: 5, end: 100, title: 'Tidy up' },
    ])
  })

  it('has no chapters for formats that have none to give, and for files without any', async () => {
    expect(await readChapters(blob(encodeWav([new Float32Array(800)], { sampleRate: 8000 })), format('wav'), 1)).toEqual([])
    expect(await readChapters(blob(withId3(buildChapterTag([]), buildMp3({ frames: 60 }))), format('mp3'), 100)).toEqual([])
    expect(await readChapters(blob(new Uint8Array(200).fill(3)), null, 100)).toEqual([])
  })

  it('fails when the file cannot be read, instead of answering "no chapters", which would be kept for good', async () => {
    const broken = { size: 5000, slice: () => { throw new Error('the disk went away') } } as unknown as Blob
    await expect(readChapters(broken, format('mp3'), 100)).rejects.toThrow('the disk went away')
    await expect(readChapters(broken, null, 100)).rejects.toThrow('the disk went away')
  })
})

describe('containerFromHead', () => {
  it('tells the container from the first bytes', () => {
    expect(containerFromHead(cat(ascii('ID3'), [3, 0, 0, 0, 0, 0, 0]))).toBe('mp3')
    expect(containerFromHead(Uint8Array.of(0xff, 0xfb, 0x90, 0x00))).toBe('mp3')
    expect(containerFromHead(cat(ascii('OggS'), [0]))).toBe('ogg')
    expect(containerFromHead(Uint8Array.from(ascii('fLaC')))).toBe('flac')
    expect(containerFromHead(cat([0, 0, 0, 24], ascii('ftypM4A '), new Uint8Array(8)))).toBe('mp4')
    expect(containerFromHead(cat(ascii('RIFF'), [0, 0, 0, 0], ascii('WAVE')))).toBe('wav')
  })

  it('is null for anything else, and for too little to tell', () => {
    expect(containerFromHead(new Uint8Array(0))).toBeNull()
    expect(containerFromHead(Uint8Array.of(1, 2, 3))).toBeNull()
    expect(containerFromHead(new Uint8Array(64).fill(7))).toBeNull()
  })
})
