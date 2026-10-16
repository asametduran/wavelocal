/** CRC-32 (IEEE 802.3, the zlib/PNG polynomial), incremental so a file can be checksummed chunk by chunk. */
const TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

/** Start value for `crc32Update`. */
export const CRC32_INIT = 0xffffffff

/** Fold `bytes` into a running CRC. Finish with `crc32Final`. */
export function crc32Update(crc: number, bytes: Uint8Array): number {
  let c = crc
  for (let i = 0; i < bytes.length; i++) c = (TABLE[(c ^ (bytes[i] as number)) & 0xff] as number) ^ (c >>> 8)
  return c >>> 0
}

export const crc32Final = (crc: number): number => (crc ^ 0xffffffff) >>> 0

/** CRC-32 of a whole buffer as an unsigned integer. */
export const crc32 = (bytes: Uint8Array): number => crc32Final(crc32Update(CRC32_INIT, bytes))
