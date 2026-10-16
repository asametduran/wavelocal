import { describe, expect, it } from 'vitest'
import { fallbackGradient, formatBadge, formatTime, formatTotal, isHiRes, spokenFormat } from './format'
import type { AudioFormat } from './audio/probe/types'

describe('formatTime', () => {
  it.each([
    [0, '0:00'],
    [5, '0:05'],
    [59.9, '0:59'],
    [60, '1:00'],
    [61, '1:01'],
    [754, '12:34'],
    [3599, '59:59'],
    [3600, '60:00'],
  ])('formats %s seconds as %s', (seconds, expected) => {
    expect(formatTime(seconds)).toBe(expected)
  })

  it.each([NaN, Infinity, -Infinity, -1, -0.5])('renders invalid input %s as 0:00', (value) => {
    expect(formatTime(value)).toBe('0:00')
  })
})

const fmt = (over: Partial<AudioFormat>): AudioFormat => ({ container: 'mp3', codec: 'mp3', sampleRate: 44100, channels: 2, bitrate: 128000, bitDepth: 0, lossless: false, vbr: false, encoderDelay: 0, encoderPadding: 0, ...over })

describe('formatBadge', () => {
  const cases: { audio: AudioFormat | null | undefined; badge: string }[] = [
    { audio: fmt({}), badge: 'MP3 · 128 kbps' },
    { audio: fmt({ bitrate: 320000 }), badge: 'MP3 · 320 kbps' },
    { audio: fmt({ bitrate: 193200, vbr: true }), badge: 'MP3 · 193 kbps VBR' },
    { audio: fmt({ codec: 'mp2', bitrate: 192000 }), badge: 'MP2 · 192 kbps' },
    { audio: fmt({ container: 'mp4', codec: 'aac', bitrate: 256000 }), badge: 'AAC · 256 kbps' },
    { audio: fmt({ container: 'aac', codec: 'aac', bitrate: 99607 }), badge: 'AAC · 100 kbps' },
    { audio: fmt({ container: 'ogg', codec: 'opus', sampleRate: 48000, bitrate: 74000, vbr: true }), badge: 'Opus · 74 kbps VBR' },
    { audio: fmt({ container: 'ogg', codec: 'vorbis', bitrate: 160000 }), badge: 'Vorbis · 160 kbps' },
    { audio: fmt({ container: 'flac', codec: 'flac', sampleRate: 96000, bitDepth: 24, lossless: true, bitrate: 2_000_000 }), badge: 'FLAC · 96 kHz · 24-bit' },
    { audio: fmt({ container: 'flac', codec: 'flac', bitDepth: 16, lossless: true }), badge: 'FLAC · 44.1 kHz · 16-bit' },
    { audio: fmt({ container: 'mp4', codec: 'alac', sampleRate: 48000, bitDepth: 24, lossless: true }), badge: 'ALAC · 48 kHz · 24-bit' },
    { audio: fmt({ container: 'wav', codec: 'pcm', bitDepth: 16, lossless: true, bitrate: 1_411_200 }), badge: 'WAV · 44.1 kHz · 16-bit' },
    { audio: fmt({ container: 'wav', codec: 'pcm', bitDepth: 24, sampleRate: 22050, lossless: true }), badge: 'WAV · 22.05 kHz · 24-bit' },
    { audio: fmt({ container: 'wav', codec: 'float', bitDepth: 32, lossless: true }), badge: 'WAV · 44.1 kHz · 32-bit float' },
    { audio: fmt({ container: 'wav', codec: 'alaw', bitDepth: 8, bitrate: 352800 }), badge: 'WAV · 353 kbps' },
    { audio: fmt({ bitrate: 0 }), badge: 'MP3' },
    { audio: fmt({ container: 'flac', codec: 'flac', sampleRate: 0, bitDepth: 0, lossless: true }), badge: 'FLAC' },
    { audio: fmt({ container: 'ogg', codec: 'unknown', bitrate: 0 }), badge: 'OGG' },
    { audio: null, badge: '' },
    { audio: undefined, badge: '' },
  ]

  it.each(cases)('summarises the format as "$badge"', ({ audio, badge }) => {
    expect(formatBadge(audio)).toBe(badge)
  })
})

describe('isHiRes', () => {
  it('is true for lossless audio above CD quality in rate or depth, and for nothing else', () => {
    expect(isHiRes(fmt({ container: 'flac', codec: 'flac', sampleRate: 96000, bitDepth: 24, lossless: true }))).toBe(true)
    expect(isHiRes(fmt({ container: 'flac', codec: 'flac', sampleRate: 48000, bitDepth: 24, lossless: true }))).toBe(true)
    expect(isHiRes(fmt({ container: 'flac', codec: 'flac', sampleRate: 96000, bitDepth: 16, lossless: true }))).toBe(true)
    expect(isHiRes(fmt({ container: 'flac', codec: 'flac', sampleRate: 44100, bitDepth: 16, lossless: true }))).toBe(false)
    expect(isHiRes(fmt({ sampleRate: 96000, bitrate: 320000 }))).toBe(false) // lossy is never hi-res
    expect(isHiRes(null)).toBe(false)
  })
})

describe('spokenFormat', () => {
  it('says the format the way a screen reader should read it', () => {
    expect(spokenFormat(fmt({ container: 'flac', codec: 'flac', sampleRate: 96000, bitDepth: 24, lossless: true }))).toBe('FLAC, 96 kilohertz, 24-bit')
    expect(spokenFormat(fmt({}))).toBe('MP3, 128 kilobits per second')
    expect(spokenFormat(fmt({ bitrate: 193200, vbr: true }))).toBe('MP3, 193 kilobits per second, variable bitrate')
    expect(spokenFormat(fmt({ container: 'wav', codec: 'float', bitDepth: 32, lossless: true }))).toBe('WAV, 44.1 kilohertz, 32-bit float')
    expect(spokenFormat(null)).toBe('')
  })
})

describe('formatTotal', () => {
  it.each([
    [0, ''],
    [Number.NaN, ''],
    [-5, ''],
    [30, '< 1 min'],
    [60, '1 min'],
    [125, '2 min'],
    [3599, '59 min'],
    [3600, '1 h'],
    [3660, '1 h 1 min'],
    [12600, '3 h 30 min'],
    [360000, '100 h'],
  ])('writes %s seconds as "%s"', (seconds, text) => {
    expect(formatTotal(seconds)).toBe(text)
  })
})

describe('fallbackGradient', () => {
  it('is deterministic for the same seed', () => {
    expect(fallbackGradient('Song' + 'Artist')).toBe(fallbackGradient('SongArtist'))
  })

  it('differs between seeds', () => {
    expect(fallbackGradient('a')).not.toBe(fallbackGradient('b'))
  })

  it('produces a layered CSS gradient with in-range hues', () => {
    // The seed hash is signed, so angles/hues may be negative; CSS wraps them, they just must stay within one turn.
    for (const seed of ['anything', 'x', 'Song' + 'Artist', '']) {
      const css = fallbackGradient(seed)
      expect(css).toMatch(/^radial-gradient\(.*\), linear-gradient\(-?\d+deg, hsl\(-?\d+ 70% 45%\), hsl\(-?\d+ 75% 30%\)\)$/)
      for (const [, value] of css.matchAll(/hsl\((-?\d+) /g)) expect(Math.abs(Number(value))).toBeLessThan(360)
    }
  })

  it('accepts the default empty seed', () => {
    expect(fallbackGradient()).toBe(fallbackGradient(''))
  })
})
