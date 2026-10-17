// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { MAX_SDP_CHARS, cleanCode, decodeSignal, encodeSignal, fromBase64Url, toBase64Url } from './signal'
import { crc32 } from './crc32'
import { FUZZ_TIMEOUT, clock, eachSeed, int, mutateText, pick, randomBytes, randomText, sameBytes, since } from '../../test-utils/fuzz'
import type { Random } from '../../test-utils/fuzz'

const looksLikeSdp = (sdp: string) => sdp.startsWith('v=0') && /\na=fingerprint:/.test(sdp) && /\nm=application /.test(sdp)

/** A session description of the shape a pairing code carries, with some lines of random content. */
function sdp(random: Random, extraLines = int(random, 30)): string {
  const hex = Array.from({ length: 32 }, () => int(random, 256).toString(16).padStart(2, '0').toUpperCase()).join(':')
  // whole characters, not UTF-16 halves: a string cannot be indexed into the pieces of an emoji
  const letters = [...'abcdefghijklmnopqrstuvwxyz0123456789 :/+-_.é€😀']
  const extra = Array.from({ length: extraLines }, () => `a=${Array.from({ length: 5 + int(random, 60) }, () => pick(random, letters)).join('')}`)
  return ['v=0', 'o=- 4611731400430051336 2 IN IP4 127.0.0.1', 's=-', 't=0 0', `a=fingerprint:sha-256 ${hex}`, 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', ...extra].join('\r\n') + '\r\n'
}

describe('pairing codes under fuzzing', { timeout: FUZZ_TIMEOUT }, () => {
  it('give back exactly the description that went in, offer or answer, compressed or not', async () => {
    await eachSeed(150, async (random) => {
      const original = sdp(random)
      const kind = random() < 0.5 ? 'offer' : 'answer'
      const result = await decodeSignal(await encodeSignal(kind, original))
      expect(result).toEqual({ ok: true, kind, sdp: original })
    })
  })

  it('survive what chat apps do to a code: spaces, line breaks, quotes, zero-width characters', async () => {
    await eachSeed(100, async (random) => {
      const original = sdp(random, 8)
      const code = await encodeSignal('offer', original)
      let noisy = ''
      for (const ch of code) noisy += ch + (random() < 0.05 ? pick(random, [' ', '\n', '\r\n', '\t', '​', '﻿', '"', "'", '`', '<', '>']) : '')
      const result = await decodeSignal(`  "${noisy}"\n`)
      expect(result).toEqual({ ok: true, kind: 'offer', sdp: original })
    })
  })

  it('never throw on a damaged code, and never accept one as a different description', async () => {
    const original = sdp(() => 0.42, 12)
    const codes = [await encodeSignal('offer', original), await encodeSignal('answer', original)]
    await eachSeed(500, async (random) => {
      const damaged = mutateText(random, mutateText(random, pick(random, codes)))
      const result = await decodeSignal(damaged)
      if (result.ok) {
        // the checksum covers the payload: a code that still reads is the same description
        expect(result.sdp).toBe(original)
        expect(looksLikeSdp(result.sdp)).toBe(true)
      } else {
        expect(result.error.length).toBeGreaterThan(0)
      }
    })
  })

  it('never throw on random text, and always say what is wrong in words', async () => {
    await eachSeed(300, async (random) => {
      const result = await decodeSignal(random() < 0.5 ? randomText(random, int(random, 500)) : `WL1.${randomText(random, int(random, 8), 'oazr.')}.${randomText(random, int(random, 200), 'abcXYZ-_09=.')}`)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toMatch(/\w/)
    })
  })

  it('refuse a code that unpacks to a mountain of data, quickly', async () => {
    const zeros = new Uint8Array(16 * 1024 * 1024)
    const stream = new CompressionStream('deflate-raw')
    const writer = stream.writable.getWriter()
    void writer.write(zeros)
    void writer.close()
    const parts: Uint8Array[] = []
    const reader = stream.readable.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      parts.push(value)
    }
    const packed = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
    let at = 0
    for (const part of parts) {
      packed.set(part, at)
      at += part.length
    }
    const code = `WL1.o.z.${toBase64Url(packed)}.${crc32(packed).toString(16).padStart(8, '0')}`
    expect(code.length).toBeLessThan(24_000) // small enough to be pasted, and a mountain when unpacked
    const started = clock()
    const result = await decodeSignal(code)
    expect(result.ok).toBe(false)
    expect(since(started)).toBeLessThan(1500)
  })

  it('refuse text that is far too long without reading all of it', async () => {
    for (const text of ['a'.repeat(5_000_000), ' '.repeat(5_000_000), `WL1.o.r.${'A'.repeat(1_000_000)}.00000000`, '.'.repeat(1_000_000)]) {
      const started = clock()
      expect((await decodeSignal(text)).ok).toBe(false)
      expect(since(started)).toBeLessThan(1000)
    }
  })

  it('refuse a description larger than any real one even if it is packed in a valid code', async () => {
    const huge = sdp(() => 0.5, 0) + 'a=x'.repeat(MAX_SDP_CHARS)
    const result = await decodeSignal(await encodeSignal('offer', huge))
    expect(result.ok).toBe(false)
  })

  it('read base64url back to the bytes it was made from, whatever their length', async () => {
    await eachSeed(300, (random) => {
      const bytes = randomBytes(random, int(random, 2000))
      const text = toBase64Url(bytes)
      expect(text).toMatch(/^[A-Za-z0-9_-]*$/)
      const back = fromBase64Url(text)
      expect(back !== null && sameBytes(back, bytes)).toBe(true)
    })
  })

  it('refuse anything that is not base64url without throwing', async () => {
    await eachSeed(300, (random) => {
      const text = randomText(random, int(random, 100))
      const back = fromBase64Url(text)
      if (back !== null) expect(text).toMatch(/^[A-Za-z0-9_-]*$/)
    })
    expect(fromBase64Url('A')).toBeNull()
    expect(fromBase64Url('AAAAA')).toBeNull()
    expect(fromBase64Url('ab+/')).toBeNull()
  })

  it('clean a code by removing, never by changing, what is left', async () => {
    await eachSeed(200, (random) => {
      const text = randomText(random, int(random, 300))
      const cleaned = cleanCode(text)
      expect(cleaned.length).toBeLessThanOrEqual(text.length)
      expect(cleanCode(cleaned)).toBe(cleaned)
      expect(/[\s"'`<>​-‍﻿]/.test(cleaned)).toBe(false)
    })
  })
})
