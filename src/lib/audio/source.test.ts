import { describe, expect, it } from 'vitest'
import { ascii, be16, be24, be32, be64, blobSource, bytesSource, le16, le32, le64, synchsafe } from './source'

describe('byte readers', () => {
  const b = Uint8Array.from([0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0, 0x01, 0x02])

  it('reads big-endian integers', () => {
    expect(be16(b, 0)).toBe(0x1234)
    expect(be24(b, 0)).toBe(0x123456)
    expect(be32(b, 0)).toBe(0x12345678)
    expect(be32(b, 4)).toBe(0x9abcdef0) // above 2^31: must stay positive
  })

  it('reads little-endian integers', () => {
    expect(le16(b, 0)).toBe(0x3412)
    expect(le32(b, 0)).toBe(0x78563412)
    expect(le32(b, 4)).toBe(0xf0debc9a)
  })

  it('reads 64-bit integers as numbers', () => {
    expect(be64(Uint8Array.from([0, 0, 0, 1, 0, 0, 0, 2]), 0)).toBe(2 ** 32 + 2)
    expect(le64(Uint8Array.from([2, 0, 0, 0, 1, 0, 0, 0]), 0)).toBe(2 ** 32 + 2)
  })

  it('returns 0 for reads past the end instead of throwing', () => {
    expect(be16(b, 9)).toBe(0)
    expect(be32(b, 8)).toBe(0)
    expect(le32(b, 100)).toBe(0)
    expect(be64(b, 5)).toBe(0)
  })

  it('reads ASCII and decodes synchsafe integers', () => {
    expect(ascii(Uint8Array.from([0x49, 0x44, 0x33, 0x04]), 0, 3)).toBe('ID3')
    expect(ascii(b, 8, 10)).toBe('\x01\x02') // clamps at the end
    expect(synchsafe(Uint8Array.from([0x00, 0x00, 0x02, 0x01]), 0)).toBe(257)
    expect(synchsafe(Uint8Array.from([0x7f, 0x7f, 0x7f, 0x7f]), 0)).toBe(0x0fffffff)
  })
})

describe('byte sources', () => {
  const data = Uint8Array.from({ length: 100 }, (_, i) => i)

  it('serves slices of an in-memory buffer', async () => {
    const s = bytesSource(data)
    expect(s.size).toBe(100)
    expect([...(await s.read(10, 3))]).toEqual([10, 11, 12])
    expect([...(await s.read(98, 10))]).toEqual([98, 99]) // short read at the end
    expect((await s.read(100, 5)).length).toBe(0)
    expect((await s.read(500, 5)).length).toBe(0)
    expect((await s.read(0, 0)).length).toBe(0)
    expect((await s.read(-5, 3)).length).toBe(0)
  })

  it('serves slices of a Blob without reading the rest', async () => {
    const blob = new Blob([data])
    const s = blobSource(blob)
    expect(s.size).toBe(100)
    expect([...(await s.read(40, 4))]).toEqual([40, 41, 42, 43])
    expect([...(await s.read(97, 99))]).toEqual([97, 98, 99])
    expect((await s.read(150, 4)).length).toBe(0)
  })

  it('returns a copy, so callers cannot corrupt the source', async () => {
    const s = bytesSource(data)
    const part = await s.read(0, 4)
    part[0] = 99
    expect((await s.read(0, 1))[0]).toBe(0)
  })
})
