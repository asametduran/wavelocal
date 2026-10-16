import { describe, expect, it } from 'vitest'
import { EMPTY_META, INDEX_VERSION, normalizeAudio, normalizeMeta } from './trackmeta'
import type { AudioFormat } from './audio/probe/types'

const audio: AudioFormat = { container: 'flac', codec: 'flac', sampleRate: 96000, channels: 2, bitrate: 2_000_000, bitDepth: 24, lossless: true, vbr: false, encoderDelay: 0, encoderPadding: 0 }

describe('EMPTY_META', () => {
  it('holds neutral values and the "never analysed" version', () => {
    expect(EMPTY_META).toEqual({ albumArtist: '', trackNo: 0, trackTotal: 0, discNo: 0, discTotal: 0, year: 0, genre: '', compilation: false, audio: null, indexed: 0 })
    expect(INDEX_VERSION).toBeGreaterThanOrEqual(1)
  })

  it('cannot be changed by accident (test factories spread it)', () => {
    expect(Object.isFrozen(EMPTY_META)).toBe(true)
  })
})

describe('normalizeMeta', () => {
  it('turns a record stored before these fields existed into neutral values', () => {
    expect(normalizeMeta(undefined)).toEqual(EMPTY_META)
    expect(normalizeMeta(null)).toEqual(EMPTY_META)
    expect(normalizeMeta({})).toEqual(EMPTY_META)
  })

  it('keeps valid values', () => {
    const meta = { albumArtist: 'Band', trackNo: 3, trackTotal: 12, discNo: 1, discTotal: 2, year: 2019, genre: 'Pop', compilation: true, audio, indexed: 1 }
    expect(normalizeMeta(meta)).toEqual(meta)
  })

  it('is idempotent', () => {
    const once = normalizeMeta({ albumArtist: 'A', trackNo: 4, year: 1999, audio, indexed: 1, genre: 'Rock' })
    expect(normalizeMeta(once)).toEqual(once)
  })

  it('repairs values of the wrong type or out of range', () => {
    expect(
      normalizeMeta({ albumArtist: 42, trackNo: -3, trackTotal: 1.5, discNo: 'two', discTotal: 99999, year: 12, genre: ['Pop'], compilation: 'yes', audio: 'flac', indexed: Number.NaN }),
    ).toEqual(EMPTY_META)
    expect(normalizeMeta({ year: 3500 }).year).toBe(0)
    expect(normalizeMeta({ year: 1000 }).year).toBe(1000)
    expect(normalizeMeta({ indexed: -1 }).indexed).toBe(0)
    expect(normalizeMeta({ indexed: 2.5 }).indexed).toBe(0)
  })

  it('cleans and caps text', () => {
    expect(normalizeMeta({ albumArtist: ` A\u0000B ${'x'.repeat(400)}` }).albumArtist.length).toBe(300)
    expect(normalizeMeta({ genre: 'g'.repeat(400) }).genre.length).toBe(100)
  })

  it('does not return the object it was given, so a record is never aliased', () => {
    const input = { audio }
    const out = normalizeMeta(input)
    expect(out.audio).not.toBe(audio)
    expect(out.audio).toEqual(audio)
  })
})

describe('normalizeAudio', () => {
  it('keeps a valid format', () => {
    expect(normalizeAudio(audio)).toEqual(audio)
  })

  it.each([[null], [undefined], ['flac'], [42], [[]], [{}], [{ container: 'nope', codec: 'flac' }], [{ container: 'mp3', codec: 'nope' }]])('rejects %j', (value) => {
    expect(normalizeAudio(value)).toBeNull()
  })

  it('repairs numbers and flags, keeping the container and codec', () => {
    expect(normalizeAudio({ container: 'mp3', codec: 'mp3', sampleRate: -1, channels: 'x', bitrate: Infinity, bitDepth: 1e12, lossless: 'true', vbr: 1, encoderDelay: -5, encoderPadding: 3.7 })).toEqual({
      container: 'mp3',
      codec: 'mp3',
      sampleRate: 0,
      channels: 0,
      bitrate: 0,
      bitDepth: 0,
      lossless: false,
      vbr: false,
      encoderDelay: 0,
      encoderPadding: 0,
    })
  })
})
