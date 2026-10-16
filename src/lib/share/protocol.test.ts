import { describe, expect, it } from 'vitest'
import { CHUNK_HEADER, LIMITS, cleanText, decodeChunk, encodeChunk, encodeCtl, encodeFileFrame, parseCtl, parseFileFrame, parseMeta, safeFileName } from './protocol'
import type { CtlMessage, TrackMeta } from './protocol'

const meta = (over: Partial<TrackMeta> = {}): TrackMeta => ({
  key: 'song.wav|1000|1700000000000',
  name: 'song.wav',
  size: 1000,
  lastModified: 1700000000000,
  type: 'audio/wav',
  title: 'Song',
  artist: 'Artist',
  album: 'Album',
  duration: 12.5,
  ...over,
})

describe('text hygiene', () => {
  it('strips control and direction-override characters and caps the length', () => {
    expect(cleanText('He\u0000llo\u202e World\u200b')).toBe('Hello World')
    expect(cleanText('x'.repeat(500))).toHaveLength(LIMITS.text)
  })

  it('reduces file names to a plain name', () => {
    expect(safeFileName('../../etc/passwd')).toBe('passwd')
    expect(safeFileName('C:\\Music\\a.mp3')).toBe('a.mp3')
    expect(safeFileName('..hidden.mp3')).toBe('hidden.mp3')
    expect(safeFileName('\u0000\u0001')).toBe('shared-track')
    expect(safeFileName('')).toBe('shared-track')
  })
})

describe('parseMeta', () => {
  it('accepts a well-formed track description', () => {
    expect(parseMeta(meta())).toEqual(meta())
  })

  it('rejects missing, mistyped and out-of-range fields', () => {
    expect(parseMeta(null)).toBeNull()
    expect(parseMeta([])).toBeNull()
    expect(parseMeta({ ...meta(), key: '' })).toBeNull()
    expect(parseMeta({ ...meta(), size: 0 })).toBeNull()
    expect(parseMeta({ ...meta(), size: LIMITS.fileBytes + 1 })).toBeNull()
    expect(parseMeta({ ...meta(), size: 1.5 })).toBeNull()
    expect(parseMeta({ ...meta(), duration: -1 })).toBeNull()
    expect(parseMeta({ ...meta(), title: 5 })).toBeNull()
    expect(parseMeta({ ...meta(), lastModified: NaN })).toBeNull()
  })

  it('sanitises display text and the file name, and drops non-audio types', () => {
    const parsed = parseMeta({ ...meta(), name: '../x/evil.mp3', title: 'A\u202eB', type: 'text/html' })
    expect(parsed).toMatchObject({ name: 'evil.mp3', title: 'AB', type: '' })
  })
})

describe('control messages', () => {
  const roundTrip = (m: CtlMessage) => parseCtl(encodeCtl(m))

  it('round-trips every message kind', () => {
    const messages: CtlMessage[] = [
      { t: 'hello', v: 1, role: 'host', name: 'Living room', canControl: true },
      { t: 'ping', id: 3, t0: 1000.5 },
      { t: 'pong', id: 3, t0: 1000.5, t1: 2000, t2: 2001 },
      { t: 'state', seq: 9, track: meta(), next: meta({ key: 'b|1|2', name: 'b.wav' }), playing: true, position: 3.2, speed: 1, at: 1700000000123 },
      { t: 'state', seq: 10, track: null, next: null, playing: false, position: 0, speed: 1, at: 5 },
      { t: 'want', key: 'song.wav|1000|1700000000000' },
      { t: 'cmd', cmd: 'toggle' },
      { t: 'cmd', cmd: 'seek', value: 42 },
      { t: 'bye' },
    ]
    for (const m of messages) expect(roundTrip(m)).toEqual(m)
  })

  it('ignores anything that is not valid JSON, not an object, or not a known message', () => {
    for (const raw of ['', 'nope', '[]', '42', 'null', '{}', '{"t":"explode"}', new ArrayBuffer(4), undefined, 7]) {
      expect(parseCtl(raw)).toBeNull()
    }
  })

  it('rejects oversized messages', () => {
    const big = JSON.stringify({ t: 'hello', v: 1, role: 'host', name: 'x'.repeat(LIMITS.ctlChars), canControl: false })
    expect(parseCtl(big)).toBeNull()
  })

  it('validates field types and ranges', () => {
    expect(parseCtl('{"t":"hello","v":1,"role":"admin","name":"x","canControl":false}')).toBeNull()
    expect(parseCtl('{"t":"ping","id":-1,"t0":1}')).toBeNull()
    expect(parseCtl('{"t":"ping","id":1,"t0":"1"}')).toBeNull()
    expect(parseCtl('{"t":"state","seq":1,"track":null,"playing":"yes","position":0,"speed":1,"at":1}')).toBeNull()
    expect(parseCtl('{"t":"state","seq":1,"track":null,"playing":true,"position":0,"speed":100,"at":1}')).toBeNull()
    expect(parseCtl('{"t":"state","seq":1,"track":{"key":"k"},"playing":true,"position":0,"speed":1,"at":1}')).toBeNull()
    expect(parseCtl('{"t":"cmd","cmd":"format-disk"}')).toBeNull()
    expect(parseCtl('{"t":"cmd","cmd":"seek"}')).toBeNull()
    expect(parseCtl('{"t":"cmd","cmd":"seek","value":-3}')).toBeNull()
    expect(parseCtl('{"t":"want","key":""}')).toBeNull()
  })

  it('shows a default name for a nameless device', () => {
    expect(parseCtl('{"t":"hello","v":1,"role":"guest","name":"\\u0000","canControl":false}')).toMatchObject({ name: 'Guest' })
  })

  it('treats a missing next track as none', () => {
    const raw = '{"t":"state","seq":1,"track":null,"playing":false,"position":0,"speed":1,"at":1}'
    expect(parseCtl(raw)).toMatchObject({ next: null })
  })
})

describe('file frames', () => {
  it('round-trips begin, end and abort', () => {
    for (const frame of [
      { t: 'begin', id: 1, meta: meta() },
      { t: 'end', id: 1, crc: 0xdeadbeef, bytes: 1000 },
      { t: 'abort', id: 1, key: 'k', reason: 'gone' },
    ] as const) {
      expect(parseFileFrame(encodeFileFrame(frame))).toEqual(frame)
    }
  })

  it('rejects malformed frames', () => {
    expect(parseFileFrame('{"t":"begin","id":1,"meta":{}}')).toBeNull()
    expect(parseFileFrame('{"t":"end","id":1,"crc":-1,"bytes":1}')).toBeNull()
    expect(parseFileFrame('{"t":"end","id":1,"crc":4294967296,"bytes":1}')).toBeNull()
    expect(parseFileFrame('{"t":"zip","id":1}')).toBeNull()
    expect(parseFileFrame('{"t":"end","crc":1,"bytes":1}')).toBeNull()
    expect(parseFileFrame(new ArrayBuffer(8))).toBeNull()
  })
})

describe('chunk frames', () => {
  it('round-trips id, index and payload', () => {
    const payload = Uint8Array.from([1, 2, 3, 250])
    const frame = encodeChunk(0xfffffffe, 70000, payload)
    expect(frame.byteLength).toBe(CHUNK_HEADER + 4)
    const decoded = decodeChunk(frame)
    expect(decoded?.id).toBe(0xfffffffe)
    expect(decoded?.index).toBe(70000)
    expect(Array.from(decoded?.bytes ?? [])).toEqual([1, 2, 3, 250])
  })

  it('rejects empty and oversized frames', () => {
    expect(decodeChunk(new ArrayBuffer(CHUNK_HEADER))).toBeNull()
    expect(decodeChunk(new ArrayBuffer(3))).toBeNull()
    expect(decodeChunk(new ArrayBuffer(CHUNK_HEADER + LIMITS.chunkBytes + 1))).toBeNull()
  })
})
