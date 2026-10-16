import { describe, expect, it } from 'vitest'
import { CRC32_INIT, crc32, crc32Final, crc32Update } from './crc32'

const bytes = (s: string) => new TextEncoder().encode(s)

describe('crc32', () => {
  it('matches the published check values', () => {
    expect(crc32(bytes(''))).toBe(0)
    expect(crc32(bytes('123456789'))).toBe(0xcbf43926)
    expect(crc32(bytes('The quick brown fox jumps over the lazy dog'))).toBe(0x414fa339)
  })

  it('gives the same answer when fed in pieces', () => {
    const data = bytes('wavelocal listens together over the local network')
    let crc = CRC32_INIT
    for (let i = 0; i < data.length; i += 7) crc = crc32Update(crc, data.subarray(i, i + 7))
    expect(crc32Final(crc)).toBe(crc32(data))
  })

  it('always returns an unsigned 32-bit integer', () => {
    const data = new Uint8Array(1000).map((_, i) => (i * 37) & 0xff)
    const value = crc32(data)
    expect(Number.isInteger(value)).toBe(true)
    expect(value).toBeGreaterThanOrEqual(0)
    expect(value).toBeLessThanOrEqual(0xffffffff)
  })

  it('detects a single flipped bit', () => {
    const data = bytes('some audio bytes')
    const flipped = data.slice()
    flipped[3] = (flipped[3] as number) ^ 1
    expect(crc32(flipped)).not.toBe(crc32(data))
  })
})
