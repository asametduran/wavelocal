import { ascii, le16, le32, le64 } from '../source'
import type { ByteSource } from '../source'
import { blankFormat } from './types'
import type { AudioCodec, ProbeResult, TagValues } from './types'

/**
 * WAV / RF64 probe: walks the RIFF chunks by their 8-byte headers (hopping over the audio, so a large `JUNK` or `data`
 * chunk costs nothing), takes the format from `fmt `, the audio length from `data` (clamped to the file, or taken from
 * `ds64` for RF64, or from the file size for a streaming writer that left it at 0) and tags from `LIST`/`INFO`.
 */

const MAX_CHUNKS = 512
const MAX_LIST = 256 * 1024

const CODECS: Record<number, AudioCodec> = { 1: 'pcm', 3: 'float', 6: 'alaw', 7: 'mulaw' }
const INFO_FIELDS: Record<string, keyof TagValues> = { INAM: 'title', IART: 'artist', IPRD: 'album', ICRD: 'date', IGNR: 'genre', ITRK: 'track', IPRT: 'track' }
const utf8 = new TextDecoder('utf-8')

interface Fmt {
  tag: number
  channels: number
  sampleRate: number
  byteRate: number
  bits: number
}

function parseFmt(b: Uint8Array): Fmt | null {
  if (b.length < 16) return null
  let tag = le16(b, 0)
  if (tag === 0xfffe && b.length >= 26) tag = le16(b, 24) // WAVE_FORMAT_EXTENSIBLE: the real tag opens the sub-format GUID
  return { tag, channels: le16(b, 2), sampleRate: le32(b, 4), byteRate: le32(b, 8), bits: le16(b, 14) }
}

/** The text entries of a `LIST`/`INFO` chunk body (which starts with the `INFO` marker). */
function infoTags(list: Uint8Array): TagValues {
  const tags: TagValues = {}
  let at = 4
  while (at + 8 <= list.length) {
    const size = le32(list, at + 4)
    const key = INFO_FIELDS[ascii(list, at, 4)]
    if (key && !tags[key]) {
      const text = utf8.decode(list.subarray(at + 8, Math.min(list.length, at + 8 + size))).replace(/\u0000/g, '').trim()
      if (text) tags[key] = text
    }
    at += 8 + size + (size & 1)
  }
  return tags
}

export async function probeWav(source: ByteSource): Promise<ProbeResult | null> {
  const head = await source.read(0, 12)
  const magic = ascii(head, 0, 4)
  if (head.length < 12 || (magic !== 'RIFF' && magic !== 'RF64' && magic !== 'BW64') || ascii(head, 8, 4) !== 'WAVE') return null
  const rf64 = magic !== 'RIFF'

  let fmt: Fmt | null = null
  let data: { bytes: number } | null = null
  let ds64: number | null = null
  let tags: TagValues = {}
  let pos = 12
  for (let i = 0; i < MAX_CHUNKS && pos + 8 <= source.size; i++) {
    const h = await source.read(pos, 8)
    if (h.length < 8) break
    const id = ascii(h, 0, 4)
    let size = le32(h, 4)
    const body = pos + 8

    if (id === 'ds64') {
      ds64 = le64(await source.read(body, 28), 8) // after the 64-bit RIFF size: the 64-bit data size
    } else if (id === 'fmt ') {
      fmt = parseFmt(await source.read(body, Math.min(size, 40)))
    } else if (id === 'LIST' && size >= 4 && size <= MAX_LIST) {
      const list = await source.read(body, size)
      if (ascii(list, 0, 4) === 'INFO') tags = { ...infoTags(list), ...tags }
    } else if (id === 'data') {
      if (rf64 && size === 0xffffffff && ds64 !== null) size = ds64
      const available = Math.max(0, source.size - body)
      const streaming = size === 0 || size === 0xffffffff
      data = { bytes: streaming ? available : Math.min(size, available) }
      if (streaming || body + size >= source.size) break // nothing worth reading after the audio
    }
    pos = body + size + (size & 1) // chunks are padded to an even size
  }

  if (!fmt || !data || fmt.channels < 1 || fmt.sampleRate < 1) return null
  const codec = CODECS[fmt.tag] ?? 'unknown'
  const known = codec !== 'unknown' && fmt.bits >= 8
  let duration: number | null = null
  let bitrate = 0
  if (known) {
    const blockAlign = Math.ceil(fmt.bits / 8) * fmt.channels
    duration = Math.floor(data.bytes / blockAlign) / fmt.sampleRate
    bitrate = fmt.sampleRate * fmt.channels * fmt.bits
  } else if (fmt.byteRate > 0) {
    duration = data.bytes / fmt.byteRate
    bitrate = fmt.byteRate * 8
  }

  return {
    format: { ...blankFormat('wav', codec), sampleRate: fmt.sampleRate, channels: fmt.channels, bitDepth: known ? fmt.bits : 0, bitrate, lossless: codec === 'pcm' || codec === 'float' },
    duration,
    tags,
    picture: null,
  }
}
