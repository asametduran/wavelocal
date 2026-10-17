import { describe, expect, it } from 'vitest'
import { decodeTextBody, isMp3, parseId3v2, rewriteId3, storableText } from './id3write'
import type { TagChanges } from './id3write'
import { buildMp3 } from '../test-utils/containers'
import { buildId3v2 } from '../test-utils/id3'
import { FUZZ_TIMEOUT, eachSeed, int, mutateBytes, pick, randomBytes, randomText, sameBytes, timed } from '../test-utils/fuzz'
import type { Random } from '../test-utils/fuzz'

const PNG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 10, 73, 68, 65, 84, 120, 156, 99, 0, 1, 0, 0, 5, 0, 1, 13, 10, 45, 180, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130])
const tagged = (frames = 20): Uint8Array =>
  buildMp3({ frames, id3v2: buildId3v2({ title: 'A Title', artist: 'An Artist', album: 'An Album', year: '1999', track: '3/12', genre: 'Rock', lyrics: '[00:01.00]hello', picture: { mime: 'image/png', data: PNG }, replayGainTrack: '-6.50 dB' }) })
const VALID = tagged()

const changesFrom = (random: Random): TagChanges => {
  const changes: TagChanges = {}
  if (random() < 0.7) changes.title = randomText(random, int(random, 60))
  if (random() < 0.7) changes.artist = randomText(random, int(random, 60))
  if (random() < 0.7) changes.album = randomText(random, int(random, 60))
  if (random() < 0.4) changes.picture = { mime: pick(random, ['image/png', 'image/jpeg', '']), data: randomBytes(random, int(random, 300)) }
  return changes
}

const frameText = (bytes: Uint8Array, id: string): string | undefined => {
  const frame = parseId3v2(bytes)?.frames.find((f) => f.id === id)
  return frame ? decodeTextBody(frame.body) : undefined
}

/** The facts about a parsed tag that must hold for any input. */
function parsedSanely(bytes: Uint8Array): void {
  const tag = parseId3v2(bytes)
  if (!tag) return
  expect([2, 3, 4]).toContain(tag.version)
  expect(tag.length).toBeGreaterThanOrEqual(10)
  let bodies = 0
  for (const frame of tag.frames) {
    expect(frame.id).toMatch(/^[A-Z0-9]+$/)
    bodies += frame.body.length
  }
  expect(bodies).toBeLessThanOrEqual(bytes.length)
}

/** Rewrite and check the promises of `rewriteId3`, for whatever bytes. */
function rewrittenSanely(input: Uint8Array, changes: TagChanges): Uint8Array {
  const existing = parseId3v2(input)
  const out = rewriteId3(input, changes)
  const tag = parseId3v2(out)
  expect(tag, 'the output starts with a tag').not.toBeNull()
  expect([3, 4]).toContain(tag?.version)
  // the audio is carried over exactly
  expect(sameBytes(out.subarray(tag?.length ?? 0), input.subarray(existing?.length ?? 0)), 'the audio is carried over exactly').toBe(true)
  // what was asked for is in the tag, as a tag can hold it (a blank value removes the field instead)
  for (const [field, id] of [['title', 'TIT2'], ['artist', 'TPE1'], ['album', 'TALB']] as const) {
    const wanted = changes[field]
    if (wanted) expect(frameText(out, id)).toBe(storableText(wanted))
    else if (wanted === '') expect(frameText(out, id)).toBeUndefined()
  }
  // writing the same changes again changes nothing: the written form is settled
  expect(sameBytes(rewriteId3(out, changes), out), 'a second rewrite changes nothing').toBe(true)
  return out
}

describe('the ID3 reader and rewriter under fuzzing', { timeout: FUZZ_TIMEOUT }, () => {
  it('reads damaged tags without throwing, and says nothing it cannot back up', async () => {
    await eachSeed(600, (random) => parsedSanely(mutateBytes(random, mutateBytes(random, VALID))))
  })

  it('reads random bytes, short ones and ones that begin like a tag', async () => {
    await eachSeed(300, (random) => {
      parsedSanely(randomBytes(random, int(random, 400)))
      parsedSanely(Uint8Array.from([0x49, 0x44, 0x33, int(random, 6), int(random, 256), int(random, 256), ...randomBytes(random, int(random, 80))]))
    })
  })

  it('rewrites damaged files without losing the audio, and settles on one form', async () => {
    await eachSeed(400, (random) => {
      rewrittenSanely(mutateBytes(random, VALID), changesFrom(random))
    })
  })

  it('rewrites random bytes and empty input into a valid tag followed by the same bytes', async () => {
    await eachSeed(150, (random) => {
      rewrittenSanely(randomBytes(random, int(random, 300)), changesFrom(random))
    })
    rewrittenSanely(new Uint8Array(0), { title: 'x' })
    rewrittenSanely(new Uint8Array(0), {})
  })

  it('writes the changes into a good file and keeps what it was not asked to change', () => {
    const out = rewrittenSanely(VALID, { title: 'New title', picture: { mime: 'image/png', data: PNG } })
    expect(frameText(out, 'TIT2')).toBe('New title')
    expect(frameText(out, 'TPE1')).toBe('An Artist')
    expect(frameText(out, 'TALB')).toBe('An Album')
    expect(parseId3v2(out)?.frames.some((f) => f.id === 'USLT')).toBe(true)
    expect(parseId3v2(out)?.frames.some((f) => f.id === 'TXXX')).toBe(true)
    expect(isMp3(out)).toBe(true)
  })

  it('stores text a tag can hold: no NUL, no half of a surrogate pair, everything else as written', () => {
    expect(storableText('a\0b\0')).toBe('ab')
    expect(storableText('x\ud800y')).toBe('x�y')
    expect(storableText('\udc00')).toBe('�')
    expect(storableText('﻿﻿name')).toBe('name')
    expect(storableText('in﻿side')).toBe('in﻿side')
    expect(storableText('😀 İstanbul Yarısı Beyoncé')).toBe('😀 İstanbul Yarısı Beyoncé')
    expect(storableText('😀')).toBe('😀')
    // and what it stores reads back whole, including text outside Latin-1
    const out = rewriteId3(VALID, { title: 'İstanbul 😀 ŞŞ', artist: 'a\0b' })
    expect(frameText(out, 'TIT2')).toBe('İstanbul 😀 ŞŞ')
    expect(frameText(out, 'TPE1')).toBe('ab')
  })

  it('does not trust a size field that claims more than the file holds', () => {
    for (const size of [[0x7f, 0x7f, 0x7f, 0x7f], [0x40, 0, 0, 0], [0, 0, 0x7f, 0x7f]]) {
      const header = Uint8Array.from([0x49, 0x44, 0x33, 3, 0, 0, ...size])
      const bytes = Uint8Array.from([...header, ...randomBytes(() => 0.5, 64)])
      const { ms } = timed(() => rewrittenSanely(bytes, { title: 'x' }))
      expect(ms).toBeLessThan(1000)
    }
  })

  it('rewrites a file with a very large cover in a reasonable time', () => {
    const cover = new Uint8Array(12_000_000).fill(7)
    const { result, ms } = timed(() => rewriteId3(tagged(), { picture: { mime: 'image/jpeg', data: cover } }))
    expect(parseId3v2(result)?.frames.find((f) => f.id === 'APIC')?.body.length).toBe(cover.length + 'image/jpeg'.length + 4)
    // about 2 s of CPU on a fast machine: the budget only has to tell that from the minutes a quadratic copy would take
    expect(ms).toBeLessThan(10_000)
  })

  it('handles a tag crowded with frames', () => {
    const frames = Array.from({ length: 3000 }, (_, i) => `TXX${String.fromCharCode(65 + (i % 26))}`)
    const body = frames.flatMap((id) => [...new TextEncoder().encode(id), 0, 0, 0, 2, 0, 0, 0, 65])
    const size = body.length
    const tag = Uint8Array.from([0x49, 0x44, 0x33, 3, 0, 0, (size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f, ...body])
    const { ms } = timed(() => rewrittenSanely(Uint8Array.from([...tag, 0xff, 0xfb, 0x90, 0x00, ...new Uint8Array(400)]), { title: 'x' }))
    expect(ms).toBeLessThan(2000)
  })
})
