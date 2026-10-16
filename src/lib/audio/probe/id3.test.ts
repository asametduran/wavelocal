import { describe, expect, it } from 'vitest'
import { bytesSource } from '../source'
import { readId3Text, skipId3v2 } from './id3'
import { ascii, cat, countingSource, id3v2Blank, syncsafe, w16le, w24be, w32be } from '../../../test-utils/containers'

const skip = (bytes: Uint8Array) => skipId3v2(bytesSource(bytes))

describe('skipId3v2', () => {
  it('is 0 when the file has no tag', async () => {
    expect(await skip(new Uint8Array(100))).toBe(0)
    expect(await skip(new Uint8Array(0))).toBe(0)
    expect(await skip(Uint8Array.from([0xff, 0xfb, 0x90, 0x00]))).toBe(0)
  })

  it('skips the whole tag, header and padding included', async () => {
    expect(await skip(cat(id3v2Blank(2048), new Uint8Array(500)))).toBe(2048)
  })

  it('also skips the footer', async () => {
    expect(await skip(cat(id3v2Blank(2048, { footer: true }), new Uint8Array(500)))).toBe(2048)
  })

  it('skips several tags in a row', async () => {
    expect(await skip(cat(id3v2Blank(300), id3v2Blank(700), new Uint8Array(500)))).toBe(1000)
  })

  it('stops at a header that is not a real tag', async () => {
    const bad = id3v2Blank(300).slice()
    bad[3] = 0xff // version byte
    expect(await skip(cat(bad, new Uint8Array(400)))).toBe(0)
    const wide = id3v2Blank(300).slice()
    wide[6] = 0x80 // size bytes are seven-bit
    expect(await skip(cat(wide, new Uint8Array(400)))).toBe(0)
  })

  it('never reports a position past the end of the file', async () => {
    const lie = id3v2Blank(300).slice()
    lie.set([0x7f, 0x7f, 0x7f, 0x7f], 6)
    expect(await skip(lie)).toBe(lie.length)
  })
})

// ---- raw text frames -----------------------------------------------------------------------------------------------

type Version = 2 | 3 | 4

const frame = (version: Version, id: string, body: number[], flags = 0): number[] =>
  version === 2 ? [...ascii(id), ...w24be(body.length), ...body] : [...ascii(id), ...(version === 4 ? syncsafe(body.length) : w32be(body.length)), flags >> 8, flags & 0xff, ...body]

const tag = (version: Version, frames: number[][], { padding = 0, flags = 0, extra = [] as number[] } = {}): Uint8Array<ArrayBuffer> => {
  const body = [...extra, ...frames.flat(), ...new Array<number>(padding).fill(0)]
  return cat([...ascii('ID3'), version, 0, flags, ...syncsafe(body.length)], body)
}

const latin1 = (s: string): number[] => [0, ...ascii(s)]
const utf8 = (s: string): number[] => [3, ...new TextEncoder().encode(s)]
const utf16 = (s: string, bom: 'le' | 'be' = 'le'): number[] => [1, ...(bom === 'le' ? [0xff, 0xfe] : [0xfe, 0xff]), ...Array.from(s).flatMap((c) => (bom === 'le' ? w16le(c.charCodeAt(0)) : w16le(c.charCodeAt(0)).reverse()))]
const utf16be = (s: string): number[] => [2, ...Array.from(s).flatMap((c) => w16le(c.charCodeAt(0)).reverse())]

const read = (bytes: Uint8Array, ...ids: string[]) => readId3Text(bytesSource(bytes), ids)

describe('readId3Text', () => {
  it('reads the raw text that jsmediatags would have cleaned (a numeric genre reference)', async () => {
    const t = tag(3, [frame(3, 'TIT2', latin1('Song')), frame(3, 'TCON', latin1('(13)'))])
    expect([...(await read(t, 'TCON'))]).toEqual([['TCON', '(13)']])
  })

  it.each([2, 3, 4] as const)('reads version 2.%d frames', async (version) => {
    const id = version === 2 ? 'TCO' : 'TCON'
    const t = tag(version, [frame(version, version === 2 ? 'TT2' : 'TIT2', latin1('x')), frame(version, id, latin1('(17)Rock'))])
    expect((await read(t, id)).get(id)).toBe('(17)Rock')
  })

  it('decodes every text encoding', async () => {
    const t = tag(4, [frame(4, 'TCON', utf8('Şarkı')), frame(4, 'TPE2', utf16('Şebnem Ferah')), frame(4, 'TALB', utf16('Aşk', 'be')), frame(4, 'TIT2', utf16be('Gece')), frame(4, 'TPE1', latin1('café'))])
    const out = await read(t, 'TCON', 'TPE2', 'TALB', 'TIT2', 'TPE1')
    expect(out.get('TCON')).toBe('Şarkı')
    expect(out.get('TPE2')).toBe('Şebnem Ferah')
    expect(out.get('TALB')).toBe('Aşk')
    expect(out.get('TIT2')).toBe('Gece')
    expect(out.get('TPE1')).toBe('café')
  })

  it('keeps several values (separated by NUL) and drops trailing NULs', async () => {
    const t = tag(4, [frame(4, 'TCON', [3, ...ascii('Rock'), 0, ...ascii('Pop'), 0])])
    expect((await read(t, 'TCON')).get('TCON')).toBe('Rock\u0000Pop')
  })

  it('hops over big frames (cover art) without reading them', async () => {
    const art = frame(3, 'APIC', [0, ...ascii('image/png'), 0, 3, 0, ...new Array<number>(500_000).fill(7)])
    const bytes = tag(3, [frame(3, 'TIT2', latin1('Song')), art, frame(3, 'TCON', latin1('(13)'))])
    const counted = countingSource(bytesSource(bytes))
    const out = await readId3Text(counted, ['TCON'])
    expect(out.get('TCON')).toBe('(13)')
    expect(counted.bytes).toBeLessThan(40_000)
  })

  it('stops at padding and at frames that run past the tag', async () => {
    expect((await read(tag(3, [frame(3, 'TIT2', latin1('x'))], { padding: 200 }), 'TCON')).size).toBe(0)
    const cut = tag(3, [frame(3, 'TCON', latin1('(13)'))])
    expect((await read(cut.slice(0, cut.length - 2), 'TCON')).size).toBe(0)
  })

  it('skips an extended header', async () => {
    const extended = [...w32be(6), 0, 0, 0, 0, 0, 0] // v2.3: size (excluding itself), flags, padding size
    const t = tag(3, [frame(3, 'TCON', latin1('(13)'))], { flags: 0x40, extra: extended })
    expect((await read(t, 'TCON')).get('TCON')).toBe('(13)')
  })

  it('leaves out compressed or encrypted frames and honours a data length indicator', async () => {
    const compressed = tag(4, [frame(4, 'TCON', latin1('(13)'), 0x0008)])
    expect((await read(compressed, 'TCON')).size).toBe(0)
    const indicated = tag(4, [frame(4, 'TCON', [0, 0, 0, 5, ...latin1('Jazz')], 0x0001)])
    expect((await read(indicated, 'TCON')).get('TCON')).toBe('Jazz')
  })

  it('is empty when there is no tag, the tag is unsynchronised, or the bytes are not a tag', async () => {
    expect((await read(new Uint8Array(100), 'TCON')).size).toBe(0)
    expect((await read(tag(3, [frame(3, 'TCON', latin1('(13)'))], { flags: 0x80 }), 'TCON')).size).toBe(0)
    expect((await read(Uint8Array.from(ascii('ID3\u0009\u0000\u0000\u0000\u0000\u0000 ')), 'TCON')).size).toBe(0)
    expect((await read(new Uint8Array(0), 'TCON')).size).toBe(0)
  })

  it('only returns what was asked for, and the first frame when there are two', async () => {
    const t = tag(3, [frame(3, 'TIT2', latin1('x')), frame(3, 'TCON', latin1('First')), frame(3, 'TCON', latin1('Second'))])
    expect([...(await read(t, 'TCON'))]).toEqual([['TCON', 'First']])
  })
})
