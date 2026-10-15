import { describe, expect, it } from 'vitest'
import { fallbackGradient, formatTime } from './format'

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
