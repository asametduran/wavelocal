/** The two checksums FLAC uses: CRC-8 (polynomial 0x07) over each frame header and CRC-16 (0x8005) over each whole frame. */

const TABLE8 = new Uint8Array(256)
const TABLE16 = new Uint16Array(256)

for (let i = 0; i < 256; i++) {
  let c8 = i
  let c16 = i << 8
  for (let bit = 0; bit < 8; bit++) {
    c8 = c8 & 0x80 ? ((c8 << 1) ^ 0x07) & 0xff : (c8 << 1) & 0xff
    c16 = c16 & 0x8000 ? ((c16 << 1) ^ 0x8005) & 0xffff : (c16 << 1) & 0xffff
  }
  TABLE8[i] = c8
  TABLE16[i] = c16
}

/** CRC-8 of `data[start, end)`, initial value 0. */
export function crc8(data: Uint8Array, start = 0, end = data.length): number {
  let crc = 0
  for (let i = start; i < end; i++) crc = TABLE8[crc ^ (data[i] ?? 0)] ?? 0
  return crc
}

/** CRC-16 of `data[start, end)`, initial value 0. */
export function crc16(data: Uint8Array, start = 0, end = data.length): number {
  let crc = 0
  for (let i = start; i < end; i++) crc = (((crc << 8) & 0xffff) ^ (TABLE16[((crc >> 8) ^ (data[i] ?? 0)) & 0xff] ?? 0)) & 0xffff
  return crc
}
