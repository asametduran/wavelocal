import { describe, expect, it } from 'vitest'
import { MAX_SDP_CHARS, cleanCode, decodeSignal, encodeSignal, fromBase64Url, toBase64Url } from './signal'

/** A realistic data-channel-only description: what Chromium produces with no STUN servers. */
const SDP = [
  'v=0',
  'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0',
  'a=extmap-allow-mixed',
  'a=msid-semantic: WMS',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  'c=IN IP4 0.0.0.0',
  'a=candidate:1 1 udp 2113937151 7c1c1a3e-3f0e-4d4e-9d9c-2f1a1c0a9b11.local 54321 typ host generation 0',
  'a=candidate:2 1 udp 2113937151 192.168.1.20 54322 typ host generation 0',
  'a=ice-ufrag:abcd',
  'a=ice-pwd:0123456789abcdef0123456789',
  'a=ice-options:trickle',
  'a=fingerprint:sha-256 AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99',
  'a=setup:actpass',
  'a=mid:0',
  'a=sctp-port:5000',
  'a=max-message-size:262144',
  '',
].join('\r\n')

describe('base64url', () => {
  it('round-trips every byte value without padding or unsafe characters', () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i)
    for (let n = 0; n <= 6; n++) {
      const slice = all.subarray(250 - n)
      const text = toBase64Url(slice)
      expect(text).toMatch(/^[A-Za-z0-9_-]*$/)
      expect(Array.from(fromBase64Url(text) ?? [])).toEqual(Array.from(slice))
    }
  })

  it('rejects text that is not base64url', () => {
    expect(fromBase64Url('ab+c')).toBeNull()
    expect(fromBase64Url('ab=c')).toBeNull()
    expect(fromBase64Url('a')).toBeNull()
  })
})

describe('pairing codes', () => {
  it('round-trips an offer and an answer', async () => {
    const offer = await decodeSignal(await encodeSignal('offer', SDP))
    expect(offer).toEqual({ ok: true, kind: 'offer', sdp: SDP })
    const answer = await decodeSignal(await encodeSignal('answer', SDP))
    expect(answer).toMatchObject({ ok: true, kind: 'answer', sdp: SDP })
  })

  it('is much shorter than the raw description and is plain copyable text', async () => {
    const code = await encodeSignal('offer', SDP)
    expect(code).toMatch(/^WL1\.o\.[zr]\.[A-Za-z0-9_-]+\.[0-9a-f]{8}$/)
    expect(code.length).toBeLessThan(SDP.length)
  })

  it('survives what chat apps and clipboards do to text', async () => {
    const code = await encodeSignal('offer', SDP)
    const wrapped = ` "${code.slice(0, 40)}\n  ${code.slice(40, 90)}​\r\n${code.slice(90)}" `
    expect(cleanCode(wrapped)).toBe(code)
    expect(await decodeSignal(wrapped)).toMatchObject({ ok: true, kind: 'offer' })
  })

  it('explains an empty paste', async () => {
    expect(await decodeSignal('  \n ')).toEqual({ ok: false, error: 'Paste the code first.' })
  })

  it('rejects text that is not a code', async () => {
    const result = await decodeSignal('hello world')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toMatch(/does not look like/)
  })

  it('recognises codes from another version', async () => {
    const result = await decodeSignal('WL9.o.r.AAAA.00000000')
    expect(result.ok === false && result.error).toMatch(/different version/)
  })

  it('catches a truncated code via the checksum', async () => {
    const code = await encodeSignal('offer', SDP)
    const parts = code.split('.')
    parts[3] = (parts[3] as string).slice(0, -6)
    const result = await decodeSignal(parts.join('.'))
    expect(result.ok).toBe(false)
  })

  it('catches a mistyped character via the checksum', async () => {
    const code = await encodeSignal('offer', SDP)
    const parts = code.split('.')
    const payload = parts[3] as string
    const i = Math.floor(payload.length / 2)
    parts[3] = payload.slice(0, i) + (payload[i] === 'A' ? 'B' : 'A') + payload.slice(i + 1)
    const result = await decodeSignal(parts.join('.'))
    expect(result.ok === false && result.error).toMatch(/typo|incomplete/)
  })

  it('refuses a valid-looking code that holds something other than a connection', async () => {
    const result = await decodeSignal(await encodeSignal('offer', 'just some text'))
    expect(result.ok === false && result.error).toMatch(/does not contain a connection/)
  })

  it('refuses a description with no data channel or fingerprint', async () => {
    expect((await decodeSignal(await encodeSignal('offer', SDP.replace('m=application', 'm=audio')))).ok).toBe(false)
    expect((await decodeSignal(await encodeSignal('offer', SDP.replace('a=fingerprint', 'a=finger')))).ok).toBe(false)
  })

  it('refuses oversized input without trying to inflate it', async () => {
    expect((await decodeSignal('WL1.o.r.' + 'A'.repeat(30_000) + '.00000000')).ok).toBe(false)
    const huge = await encodeSignal('offer', SDP + 'a=x:' + 'y'.repeat(MAX_SDP_CHARS) + '\r\n')
    expect((await decodeSignal(huge)).ok).toBe(false)
  })

  it('refuses a payload that only claims to be compressed', async () => {
    const body = toBase64Url(new TextEncoder().encode('not deflate data at all'))
    const result = await decodeSignal(`WL1.o.z.${body}.00000000`)
    expect(result.ok).toBe(false)
  })
})
