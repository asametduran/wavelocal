import type { AudioContainer, AudioFormat } from '../audio/probe/types'
import { ascii, blobSource } from '../audio/source'
import type { ByteSource } from '../audio/source'
import { readId3Chapters } from './id3'
import { readMp4Chapters } from './mp4'
import { normalizeChapters } from './normalize'
import type { Chapter, RawChapter } from './types'
import { readFlacChapters, readOggChapters } from './vorbis'

/**
 * The chapters of a file, whichever way its format keeps them: ID3 `CHAP` frames (MP3, ADTS AAC, and FLAC with an ID3 tag),
 * the Nero atom or a QuickTime chapter track (MP4, M4A, M4B), Vorbis comments (Ogg Vorbis, Opus, FLAC). The result is always
 * normalised: ordered, within the file, with clean titles. A file that has none, or cannot be read, has an empty list.
 */

/** The container the first bytes of a file show, for a track imported before its container was recorded with it. */
export function containerFromHead(head: Uint8Array): AudioContainer | null {
  const four = ascii(head, 0, 4)
  if (four.startsWith('ID3') || ((head[0] ?? 0) === 0xff && ((head[1] ?? 0) & 0xe0) === 0xe0)) return 'mp3'
  if (four === 'OggS') return 'ogg'
  if (four === 'fLaC') return 'flac'
  if (four === 'RIFF') return 'wav'
  if (ascii(head, 4, 4) === 'ftyp') return 'mp4'
  return null
}

async function rawChapters(source: ByteSource, container: AudioContainer | null): Promise<RawChapter[]> {
  switch (container) {
    case 'mp4':
      return readMp4Chapters(source)
    case 'ogg':
      return readOggChapters(source)
    case 'flac': {
      const comments = await readFlacChapters(source)
      return comments.length > 0 ? comments : readId3Chapters(source) // a FLAC file may carry an ID3 tag as well
    }
    case 'wav':
      return []
    default:
      return readId3Chapters(source) // MP3, ADTS AAC, and a file whose container is not known
  }
}

/**
 * `format` is what the import probe recorded with the track (null for an older library: the first bytes are looked at);
 * `duration` is in seconds, 0 if not known. A file that is damaged in itself has no chapters (the readers never throw on
 * bad bytes), but one that cannot be *read* rejects: "no chapters" would be kept as an answer, and the chapters of a file
 * that was only unreachable for a moment would never be looked for again.
 */
export async function readChapters(file: Blob, format: AudioFormat | null, duration: number): Promise<Chapter[]> {
  const source = blobSource(file)
  const container = format?.container ?? containerFromHead(await source.read(0, 16))
  return normalizeChapters(await rawChapters(source, container), duration)
}
