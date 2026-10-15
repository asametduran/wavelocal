/**
 * MD5 (RFC 1321). FLAC stores the MD5 of the decoded PCM in its STREAMINFO block, so a decoder can prove that it
 * reproduced the original samples bit for bit. Incremental, so it can be fed one decoded frame at a time.
 */

const SHIFTS = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21]
const K = Uint32Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0)

const rotl = (x: number, n: number): number => ((x << n) | (x >>> (32 - n))) >>> 0

export class Md5 {
  private state = Uint32Array.of(0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476)
  private block = new Uint8Array(64)
  private filled = 0
  private total = 0

  update(data: Uint8Array): this {
    this.total += data.length
    let offset = 0
    if (this.filled > 0) {
      const take = Math.min(64 - this.filled, data.length)
      this.block.set(data.subarray(0, take), this.filled)
      this.filled += take
      offset = take
      if (this.filled === 64) {
        this.compress(this.block, 0)
        this.filled = 0
      }
    }
    for (; offset + 64 <= data.length; offset += 64) this.compress(data, offset)
    if (offset < data.length) {
      this.block.set(data.subarray(offset), 0)
      this.filled = data.length - offset
    }
    return this
  }

  /** The 16-byte digest of everything fed so far. Does not disturb the running state, so more data may follow. */
  digest(): Uint8Array {
    const copy = new Md5()
    copy.state.set(this.state)
    copy.block.set(this.block)
    copy.filled = this.filled
    copy.total = this.total

    const bitLength = this.total * 8
    const padLength = (this.filled < 56 ? 56 : 120) - this.filled
    const tail = new Uint8Array(padLength + 8)
    tail[0] = 0x80
    const view = new DataView(tail.buffer)
    view.setUint32(padLength, bitLength >>> 0, true)
    view.setUint32(padLength + 4, Math.floor(bitLength / 4294967296) >>> 0, true)
    copy.update(tail)

    const out = new Uint8Array(16)
    const outView = new DataView(out.buffer)
    copy.state.forEach((word, i) => outView.setUint32(i * 4, word, true))
    return out
  }

  private compress(data: Uint8Array, offset: number): void {
    const m = new Uint32Array(16)
    for (let i = 0; i < 16; i++) {
      const o = offset + i * 4
      m[i] = ((data[o] ?? 0) | ((data[o + 1] ?? 0) << 8) | ((data[o + 2] ?? 0) << 16) | ((data[o + 3] ?? 0) << 24)) >>> 0
    }
    let [a, b, c, d] = this.state as unknown as [number, number, number, number]
    for (let i = 0; i < 64; i++) {
      let f: number
      let g: number
      if (i < 16) {
        f = (b & c) | (~b & d)
        g = i
      } else if (i < 32) {
        f = (d & b) | (~d & c)
        g = (5 * i + 1) % 16
      } else if (i < 48) {
        f = b ^ c ^ d
        g = (3 * i + 5) % 16
      } else {
        f = c ^ (b | ~d)
        g = (7 * i) % 16
      }
      f = (f + a + (K[i] ?? 0) + (m[g] ?? 0)) >>> 0
      a = d
      d = c
      c = b
      b = (b + rotl(f, SHIFTS[i] ?? 7)) >>> 0
    }
    this.state[0] = ((this.state[0] ?? 0) + a) >>> 0
    this.state[1] = ((this.state[1] ?? 0) + b) >>> 0
    this.state[2] = ((this.state[2] ?? 0) + c) >>> 0
    this.state[3] = ((this.state[3] ?? 0) + d) >>> 0
  }
}

export const toHex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

/** Hex MD5 of a byte array. */
export const md5Hex = (data: Uint8Array): string => toHex(new Md5().update(data).digest())
