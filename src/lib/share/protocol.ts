/**
 * Wire format between two Wavelocal devices. Two ordered WebRTC data channels carry it:
 *  - `ctl`: small JSON messages (hello, clock pings, playback state, requests, remote commands),
 *  - `file`: one track at a time, as JSON `begin`/`end`/`abort` frames around binary chunk frames,
 * so a large transfer never delays a clock ping or a pause. Everything received is untrusted and validated here.
 */

export const PROTOCOL_VERSION = 1
export const CTL_LABEL = 'ctl'
export const FILE_LABEL = 'file'

/** Hard limits applied to everything a peer can make us allocate or display. */
export const LIMITS = {
  ctlChars: 8_192,
  text: 200,
  fileNameChars: 255,
  /** Largest track a guest accepts (memory is the limit: the file is assembled in RAM before it is saved). */
  fileBytes: 1024 * 1024 * 1024,
  chunkBytes: 64 * 1024,
} as const

export type ShareRole = 'host' | 'guest'

/** What the other device needs to recognise a track and ask for it. */
export interface TrackMeta {
  /** The library dedupe key `name|size|lastModified`: equal keys mean the guest already owns the very same file. */
  key: string
  name: string
  size: number
  lastModified: number
  type: string
  title: string
  artist: string
  album: string
  duration: number
}

export type RemoteCommand = 'toggle' | 'play' | 'pause' | 'next' | 'prev' | 'seek'

export type CtlMessage =
  | { t: 'hello'; v: number; role: ShareRole; name: string; canControl: boolean }
  | { t: 'ping'; id: number; t0: number }
  | { t: 'pong'; id: number; t0: number; t1: number; t2: number }
  | { t: 'state'; seq: number; track: TrackMeta | null; next: TrackMeta | null; playing: boolean; position: number; speed: number; at: number }
  | { t: 'want'; key: string }
  | { t: 'cmd'; cmd: RemoteCommand; value?: number }
  | { t: 'bye' }

export type FileFrame =
  | { t: 'begin'; id: number; meta: TrackMeta }
  | { t: 'end'; id: number; crc: number; bytes: number }
  | { t: 'abort'; id: number; key: string; reason: string }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown, min = -Infinity, max = Infinity): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max
const int = (v: unknown, min: number, max: number): v is number => num(v, min, max) && Number.isInteger(v)
const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max

/** Remove control and bidi-override characters and cap the length of text that came from the other device before it is shown. */
export function cleanText(value: string, max: number = LIMITS.text): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, '')
    .trim()
    .slice(0, max)
}

/** A file name safe to hand to the library: no folders, no control characters, never empty. */
export function safeFileName(name: string): string {
  const base = cleanText(name, LIMITS.fileNameChars).split(/[\\/]/).pop() ?? ''
  const trimmed = base.replace(/^\.+/, '').trim()
  return trimmed || 'shared-track'
}

export function parseMeta(v: unknown): TrackMeta | null {
  if (!isObj(v)) return null
  if (!str(v.key, 600) || !str(v.name, LIMITS.fileNameChars) || !str(v.type, 100) || !v.key) return null
  if (!int(v.size, 1, LIMITS.fileBytes) || !int(v.lastModified, 0, 8.64e15)) return null
  if (!str(v.title, LIMITS.text) || !str(v.artist, LIMITS.text) || !str(v.album, LIMITS.text) || !num(v.duration, 0, 86_400)) return null
  return {
    key: v.key,
    name: safeFileName(v.name),
    size: v.size,
    lastModified: v.lastModified,
    type: /^audio\/[\w.+-]{1,60}$/i.test(v.type) ? v.type.toLowerCase() : '',
    title: cleanText(v.title),
    artist: cleanText(v.artist),
    album: cleanText(v.album),
    duration: v.duration,
  }
}

const COMMANDS: readonly RemoteCommand[] = ['toggle', 'play', 'pause', 'next', 'prev', 'seek']

/** Parse and validate one control message. Anything malformed (or oversized) yields null and is ignored by the caller. */
export function parseCtl(raw: unknown): CtlMessage | null {
  if (typeof raw !== 'string' || raw.length > LIMITS.ctlChars) return null
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isObj(v)) return null
  switch (v.t) {
    case 'hello':
      if (!int(v.v, 0, 1000) || (v.role !== 'host' && v.role !== 'guest') || !str(v.name, 400) || typeof v.canControl !== 'boolean') return null
      return { t: 'hello', v: v.v, role: v.role, name: cleanText(v.name, 40) || (v.role === 'host' ? 'Host' : 'Guest'), canControl: v.canControl }
    case 'ping':
      return int(v.id, 0, 2 ** 31) && num(v.t0) ? { t: 'ping', id: v.id, t0: v.t0 } : null
    case 'pong':
      return int(v.id, 0, 2 ** 31) && num(v.t0) && num(v.t1) && num(v.t2) ? { t: 'pong', id: v.id, t0: v.t0, t1: v.t1, t2: v.t2 } : null
    case 'state': {
      if (!int(v.seq, 0, 2 ** 31) || typeof v.playing !== 'boolean' || !num(v.position, 0, 86_400) || !num(v.speed, 0.25, 4) || !num(v.at)) return null
      const track = v.track === null ? null : parseMeta(v.track)
      const next = v.next === null || v.next === undefined ? null : parseMeta(v.next)
      if (v.track !== null && !track) return null
      return { t: 'state', seq: v.seq, track, next, playing: v.playing, position: v.position, speed: v.speed, at: v.at }
    }
    case 'want':
      return str(v.key, 600) && v.key ? { t: 'want', key: v.key } : null
    case 'cmd': {
      const cmd = COMMANDS.find((c) => c === v.cmd)
      if (!cmd) return null
      if (cmd === 'seek') return num(v.value, 0, 86_400) ? { t: 'cmd', cmd, value: v.value } : null
      return { t: 'cmd', cmd }
    }
    case 'bye':
      return { t: 'bye' }
    default:
      return null
  }
}

export const encodeCtl = (message: CtlMessage): string => JSON.stringify(message)

/** Parse one JSON frame of the file channel. */
export function parseFileFrame(raw: unknown): FileFrame | null {
  if (typeof raw !== 'string' || raw.length > LIMITS.ctlChars) return null
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isObj(v) || !int(v.id, 0, 2 ** 31)) return null
  switch (v.t) {
    case 'begin': {
      const meta = parseMeta(v.meta)
      return meta ? { t: 'begin', id: v.id, meta } : null
    }
    case 'end':
      return int(v.crc, 0, 0xffffffff) && int(v.bytes, 0, LIMITS.fileBytes) ? { t: 'end', id: v.id, crc: v.crc, bytes: v.bytes } : null
    case 'abort':
      return str(v.key, 600) && str(v.reason, 200) ? { t: 'abort', id: v.id, key: v.key, reason: cleanText(v.reason) } : null
    default:
      return null
  }
}

export const encodeFileFrame = (frame: FileFrame): string => JSON.stringify(frame)

/** Chunk frame: `u32 transferId | u32 chunkIndex | bytes`, big-endian. */
export const CHUNK_HEADER = 8

export function encodeChunk(id: number, index: number, bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(CHUNK_HEADER + bytes.length)
  const view = new DataView(out)
  view.setUint32(0, id)
  view.setUint32(4, index)
  new Uint8Array(out, CHUNK_HEADER).set(bytes)
  return out
}

export function decodeChunk(buffer: ArrayBuffer): { id: number; index: number; bytes: Uint8Array } | null {
  if (buffer.byteLength <= CHUNK_HEADER || buffer.byteLength > CHUNK_HEADER + LIMITS.chunkBytes) return null
  const view = new DataView(buffer)
  return { id: view.getUint32(0), index: view.getUint32(4), bytes: new Uint8Array(buffer, CHUNK_HEADER) }
}
