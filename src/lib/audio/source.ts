/**
 * Random access to the bytes of a file, so a parser can read just the headers it needs instead of loading the whole
 * thing. The container probes (`probe/`) and the Vorbis comment reader work on this, which also lets the tests count
 * exactly how much of a (virtual, hundreds of megabytes long) file a probe touches.
 */
export interface ByteSource {
  readonly size: number
  /** Up to `length` bytes from `offset`: fewer at the end of the file, none past it. Always a fresh copy. */
  read(offset: number, length: number): Promise<Uint8Array>
}

const none = (): Uint8Array => new Uint8Array(0)

export function bytesSource(bytes: Uint8Array): ByteSource {
  return {
    size: bytes.length,
    read: async (offset, length) => (length > 0 && offset >= 0 && offset < bytes.length ? bytes.slice(offset, Math.min(bytes.length, offset + length)) : none()),
  }
}

export function blobSource(blob: Blob): ByteSource {
  return {
    size: blob.size,
    read: async (offset, length) =>
      length > 0 && offset >= 0 && offset < blob.size ? new Uint8Array(await blob.slice(offset, Math.min(blob.size, offset + length)).arrayBuffer()) : none(),
  }
}

// ---- integer readers: out-of-range reads give 0 (a damaged file must never throw out of a probe) ----

const byte = (b: Uint8Array, o: number): number => b[o] ?? 0

export const be16 = (b: Uint8Array, o: number): number => (o >= 0 && o + 2 <= b.length ? (byte(b, o) << 8) | byte(b, o + 1) : 0)
export const be24 = (b: Uint8Array, o: number): number => (o >= 0 && o + 3 <= b.length ? (byte(b, o) << 16) | (byte(b, o + 1) << 8) | byte(b, o + 2) : 0)
export const be32 = (b: Uint8Array, o: number): number =>
  o >= 0 && o + 4 <= b.length ? byte(b, o) * 0x1000000 + ((byte(b, o + 1) << 16) | (byte(b, o + 2) << 8) | byte(b, o + 3)) : 0
export const be64 = (b: Uint8Array, o: number): number => (o >= 0 && o + 8 <= b.length ? be32(b, o) * 0x100000000 + be32(b, o + 4) : 0)

export const le16 = (b: Uint8Array, o: number): number => (o >= 0 && o + 2 <= b.length ? byte(b, o) | (byte(b, o + 1) << 8) : 0)
export const le32 = (b: Uint8Array, o: number): number =>
  o >= 0 && o + 4 <= b.length ? byte(b, o) + ((byte(b, o + 1) << 8) | (byte(b, o + 2) << 16)) + byte(b, o + 3) * 0x1000000 : 0
export const le64 = (b: Uint8Array, o: number): number => (o >= 0 && o + 8 <= b.length ? le32(b, o) + le32(b, o + 4) * 0x100000000 : 0)

/** ID3v2 sizes: four bytes of seven bits each. */
export const synchsafe = (b: Uint8Array, o: number): number =>
  o >= 0 && o + 4 <= b.length ? ((byte(b, o) & 0x7f) << 21) | ((byte(b, o + 1) & 0x7f) << 14) | ((byte(b, o + 2) & 0x7f) << 7) | (byte(b, o + 3) & 0x7f) : 0

/** `n` bytes as a Latin-1 string (clamped to the buffer). */
export function ascii(b: Uint8Array, o: number, n: number): string {
  let s = ''
  const end = Math.min(b.length, o + n)
  for (let i = Math.max(0, o); i < end; i++) s += String.fromCharCode(byte(b, i))
  return s
}
