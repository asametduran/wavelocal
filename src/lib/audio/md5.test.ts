import { describe, expect, it } from 'vitest'
import { crc16, crc8 } from './crc'
import { Md5, md5Hex, toHex } from './md5'

const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0))

describe('md5', () => {
  // RFC 1321 test suite
  it.each([
    ['', 'd41d8cd98f00b204e9800998ecf8427e'],
    ['a', '0cc175b9c0f1b6a831c399e269772661'],
    ['abc', '900150983cd24fb0d6963f7d28e17f72'],
    ['message digest', 'f96b697d7cb7938d525a2f31aaf161d0'],
    ['abcdefghijklmnopqrstuvwxyz', 'c3fcd3d76192e4007dfb496cca67e13b'],
    ['ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', 'd174ab98d277d9f5a5611c2c9f419d9f'],
    ['12345678901234567890123456789012345678901234567890123456789012345678901234567890', '57edf4a22be3c955ac49da2e2107b67a'],
    ['The quick brown fox jumps over the lazy dog', '9e107d9d372bb6826bd81d3542a419d6'],
  ])('matches the reference digest of %j', (input, expected) => {
    expect(md5Hex(ascii(input))).toBe(expected)
  })

  it('handles a million bytes', () => {
    expect(md5Hex(new Uint8Array(1_000_000).fill(0x61))).toBe('7707d6ae4e027c70eea2a935c2296f21')
  })

  it('gives the same digest however the data is split into updates', () => {
    const data = Uint8Array.from({ length: 1000 }, (_, i) => (i * 31 + 7) & 0xff)
    const whole = md5Hex(data)
    for (const step of [1, 3, 55, 56, 63, 64, 65, 127, 333]) {
      const md5 = new Md5()
      for (let i = 0; i < data.length; i += step) md5.update(data.subarray(i, i + step))
      expect(toHex(md5.digest())).toBe(whole)
    }
  })

  it('digest() does not disturb the running state', () => {
    const md5 = new Md5().update(ascii('The quick brown fox '))
    const partial = toHex(md5.digest())
    expect(partial).toBe(toHex(md5.digest()))
    md5.update(ascii('jumps over the lazy dog'))
    expect(toHex(md5.digest())).toBe('9e107d9d372bb6826bd81d3542a419d6')
  })

  it('handles lengths around the padding boundary (55, 56, 57, 63, 64, 65 bytes)', () => {
    // (these lengths straddle the 56-byte padding limit; the reference vectors above pin the algorithm itself)
    for (const n of [55, 56, 57, 63, 64, 65]) {
      const a = md5Hex(new Uint8Array(n).fill(0x62))
      const incremental = new Md5()
      for (let i = 0; i < n; i++) incremental.update(Uint8Array.of(0x62))
      expect(toHex(incremental.digest())).toBe(a)
      expect(a).toMatch(/^[0-9a-f]{32}$/)
    }
  })
})

describe('crc', () => {
  // standard check values for the ASCII string "123456789"
  const check = ascii('123456789')

  it('crc8 (poly 0x07) matches its check value', () => {
    expect(crc8(check)).toBe(0xf4)
  })

  it('crc16 (poly 0x8005, init 0, no reflection) matches its check value', () => {
    expect(crc16(check)).toBe(0xfee8)
  })

  it('both are 0 for empty input and honour start/end', () => {
    expect(crc8(new Uint8Array(0))).toBe(0)
    expect(crc16(new Uint8Array(0))).toBe(0)
    expect(crc8(ascii('xx123456789yy'), 2, 11)).toBe(0xf4)
    expect(crc16(ascii('xx123456789yy'), 2, 11)).toBe(0xfee8)
  })

  it('a CRC appended to its data makes the CRC of the whole equal zero', () => {
    const data = ascii('some frame header bytes')
    const c8 = crc8(data)
    expect(crc8(Uint8Array.of(...data, c8))).toBe(0)
    const c16 = crc16(data)
    expect(crc16(Uint8Array.of(...data, c16 >> 8, c16 & 0xff))).toBe(0)
  })

  it('detects a single flipped bit', () => {
    const data = Uint8Array.from({ length: 64 }, (_, i) => i * 3)
    const original = crc16(data)
    for (let bit = 0; bit < 64 * 8; bit += 37) {
      const copy = data.slice()
      copy[bit >> 3] = (copy[bit >> 3] ?? 0) ^ (1 << (bit & 7))
      expect(crc16(copy)).not.toBe(original)
    }
  })
})
