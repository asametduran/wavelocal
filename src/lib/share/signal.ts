/**
 * Pairing codes. With no signalling server, two devices connect by exchanging two short text codes (an invite and a
 * reply) over any channel the people already have: a chat message, a note, reading it out, a QR scanner.
 *
 * A code is `WL1.<o|a>.<z|r>.<payload>.<crc>`: protocol version, offer or answer, deflate-compressed or raw, the
 * base64url session description, and a CRC-32 of the payload bytes so a truncated or mistyped code is rejected with a
 * clear message instead of failing deep inside WebRTC.
 */
import { crc32 } from './crc32'

export type SignalKind = 'offer' | 'answer'

export type SignalResult = { ok: true; kind: SignalKind; sdp: string } | { ok: false; error: string }

const VERSION = 'WL1'
/** A real description is 1-3 kB; anything far larger is not ours (and would be expensive to inflate). */
export const MAX_SDP_CHARS = 16_000
const MAX_CODE_CHARS = 24_000

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

export function toBase64Url(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null
  try {
    const s = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4))
    const out = new Uint8Array(s.length)
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream, limit: number): Promise<Uint8Array | null> {
  const writer = stream.writable.getWriter()
  // write errors surface through the readable side; awaiting them here would deadlock on a full pipe
  void writer.write(bytes as BufferSource).catch(() => {})
  void writer.close().catch(() => {})
  const reader = stream.readable.getReader()
  const parts: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      if (total > limit) {
        await reader.cancel().catch(() => {})
        return null
      }
      parts.push(value)
    }
  } catch {
    return null
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

const canCompress = () => typeof CompressionStream === 'function' && typeof DecompressionStream === 'function'

/** Turn a session description into a pairing code. */
export async function encodeSignal(kind: SignalKind, sdp: string): Promise<string> {
  const raw = encoder.encode(sdp)
  const packed = canCompress() ? await pipe(raw, new CompressionStream('deflate-raw'), MAX_SDP_CHARS * 4) : null
  const useZ = packed !== null && packed.length < raw.length
  const body = useZ ? packed : raw
  return [VERSION, kind === 'offer' ? 'o' : 'a', useZ ? 'z' : 'r', toBase64Url(body), crc32(body).toString(16).padStart(8, '0')].join('.')
}

/** Strip what chat apps and copy/paste add around a code: whitespace, line breaks, quotes, zero-width characters. */
export function cleanCode(input: string): string {
  return input.replace(/[\s​-‍﻿"'`<>]/g, '')
}

const looksLikeSdp = (sdp: string) => sdp.startsWith('v=0') && /\na=fingerprint:/.test(sdp) && /\nm=application /.test(sdp)

/** Read a pairing code. Never throws: every problem comes back as a message a person can act on. */
export async function decodeSignal(input: string): Promise<SignalResult> {
  const code = cleanCode(input)
  if (!code) return { ok: false, error: 'Paste the code first.' }
  if (code.length > MAX_CODE_CHARS) return { ok: false, error: 'That is too long to be a Wavelocal code.' }
  const parts = code.split('.')
  if (parts[0] !== VERSION || parts.length !== 5) {
    return { ok: false, error: parts[0]?.startsWith('WL') ? 'This code is from a different version of Wavelocal.' : 'That does not look like a Wavelocal code.' }
  }
  const [, k, z, payload = '', check = ''] = parts
  if ((k !== 'o' && k !== 'a') || (z !== 'z' && z !== 'r')) return { ok: false, error: 'That does not look like a Wavelocal code.' }
  const body = fromBase64Url(payload)
  if (!body || !body.length) return { ok: false, error: 'The code is damaged. Copy it again, all of it.' }
  if (crc32(body).toString(16).padStart(8, '0') !== check.toLowerCase()) return { ok: false, error: 'The code is incomplete or has a typo. Copy it again, all of it.' }
  let bytes: Uint8Array | null = body
  if (z === 'z') {
    if (!canCompress()) return { ok: false, error: 'This browser cannot read compressed codes.' }
    bytes = await pipe(body, new DecompressionStream('deflate-raw'), MAX_SDP_CHARS * 4)
    if (!bytes) return { ok: false, error: 'The code is damaged. Copy it again, all of it.' }
  }
  let sdp: string
  try {
    sdp = decoder.decode(bytes)
  } catch {
    return { ok: false, error: 'The code is damaged. Copy it again, all of it.' }
  }
  if (sdp.length > MAX_SDP_CHARS || !looksLikeSdp(sdp)) return { ok: false, error: 'That code does not contain a connection.' }
  return { ok: true, kind: k === 'o' ? 'offer' : 'answer', sdp }
}
