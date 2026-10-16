import { ascii, be24, be32 } from '../source'
import type { ByteSource } from '../source'
import { MAX_PICTURE_BYTES, parseFlacPicture, parseVorbisComments, tagsFromVorbis } from '../vorbis'
import { skipId3v2 } from './id3'
import { blankFormat } from './types'
import type { ProbeResult, TagValues } from './types'

/**
 * FLAC probe: walks the metadata blocks (a 4-byte header each, so the audio frames are never read) for STREAMINFO
 * (rate, channels, bit depth, sample count), the Vorbis comments and the cover art.
 */

const MAX_BLOCKS = 256
const MAX_COMMENT_BYTES = 4 * 1024 * 1024
const FRONT_COVER = 3

interface Candidate {
  kind: number
  mime: string
  bytes: Uint8Array<ArrayBuffer>
}

export async function probeFlac(source: ByteSource): Promise<ProbeResult | null> {
  let pos = await skipId3v2(source)
  if (ascii(await source.read(pos, 4), 0, 4) !== 'fLaC') return null
  pos += 4

  let info: Uint8Array | null = null
  let tags: TagValues = {}
  let cover: Candidate | null = null

  for (let i = 0; i < MAX_BLOCKS; i++) {
    const head = await source.read(pos, 4)
    if (head.length < 4) break
    const last = ((head[0] ?? 0) & 0x80) !== 0
    const type = (head[0] ?? 0) & 0x7f
    const length = be24(head, 1)
    const body = pos + 4

    if (type === 0 && !info && length >= 34) {
      info = await source.read(body, 34)
    } else if (type === 4 && length <= MAX_COMMENT_BYTES && Object.keys(tags).length === 0) {
      const comments = parseVorbisComments(await source.read(body, length))
      if (comments) tags = tagsFromVorbis(comments)
    } else if (type === 6 && length <= MAX_PICTURE_BYTES + 4096) {
      const block = await source.read(body, length)
      const ref = parseFlacPicture(block)
      if (ref && ref.length <= MAX_PICTURE_BYTES && ref.mime.startsWith('image/') && (!cover || (ref.kind === FRONT_COVER && cover.kind !== FRONT_COVER))) {
        cover = { kind: ref.kind, mime: ref.mime, bytes: block.slice(ref.start, ref.start + ref.length) }
      }
    }

    pos = body + length
    if (last || pos >= source.size) break
  }

  if (!info || info.length < 34) return null
  const sampleRate = ((info[10] ?? 0) << 12) | ((info[11] ?? 0) << 4) | ((info[12] ?? 0) >> 4)
  if (sampleRate <= 0) return null
  const channels = (((info[12] ?? 0) >> 1) & 7) + 1
  const bitDepth = ((((info[12] ?? 0) & 1) << 4) | ((info[13] ?? 0) >> 4)) + 1
  const samples = ((info[13] ?? 0) & 0x0f) * 0x100000000 + be32(info, 14)

  const duration = samples > 0 ? samples / sampleRate : null
  const audioBytes = Math.max(0, source.size - pos)
  return {
    format: { ...blankFormat('flac', 'flac'), sampleRate, channels, bitDepth, lossless: true, bitrate: duration ? Math.round((audioBytes * 8) / duration) : 0 },
    duration,
    tags,
    picture: cover ? new Blob([cover.bytes], { type: cover.mime }) : null,
  }
}
