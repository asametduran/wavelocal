import { describe, expect, it } from 'vitest'
import { AA, SURFACES, accentTheme, contrastRatio, luminance, onColor, parseHex, readableOn, toHex } from './contrast'
import type { Rgb } from './contrast'
import { ACCENT_PRESETS } from '../hooks/useTheme'

const rgb = (hex: string): Rgb => {
  const v = parseHex(hex)
  if (!v) throw new Error(`bad colour ${hex}`)
  return v
}

describe('parseHex / toHex', () => {
  it('parses six-digit hex with or without #', () => {
    expect(parseHex('#a78bfa')).toEqual([167, 139, 250])
    expect(parseHex('A78BFA')).toEqual([167, 139, 250])
  })
  it('rejects anything else', () => {
    for (const bad of ['', '#fff', '#12345', '#gggggg', 'rgb(1,2,3)']) expect(parseHex(bad)).toBeNull()
  })
  it('round-trips and clamps', () => {
    expect(toHex([167, 139, 250])).toBe('#a78bfa')
    expect(toHex([-5, 300, 12.4])).toBe('#00ff0c')
  })
})

describe('contrastRatio', () => {
  it('matches the WCAG reference values', () => {
    expect(luminance([255, 255, 255])).toBeCloseTo(1, 6)
    expect(luminance([0, 0, 0])).toBe(0)
    expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 5)
    expect(contrastRatio([255, 255, 255], [255, 255, 255])).toBeCloseTo(1, 6)
    // #767676 on white is the well-known smallest grey that passes AA (4.54:1)
    expect(contrastRatio(rgb('#767676'), [255, 255, 255])).toBeCloseTo(4.54, 2)
  })
  it('is symmetric', () => {
    expect(contrastRatio(rgb('#336699'), rgb('#ffeeaa'))).toBeCloseTo(contrastRatio(rgb('#ffeeaa'), rgb('#336699')), 10)
  })
})

describe('onColor', () => {
  it('picks the foreground with the higher contrast', () => {
    expect(onColor([255, 255, 0])).toBe('#000000')
    expect(onColor([0, 0, 128])).toBe('#ffffff')
    expect(onColor(rgb('#a78bfa'))).toBe('#000000')
  })
  it('reaches AA body-text contrast on every colour of a coarse sweep', () => {
    for (let r = 0; r <= 255; r += 51)
      for (let g = 0; g <= 255; g += 51)
        for (let b = 0; b <= 255; b += 51) {
          const bg: Rgb = [r, g, b]
          expect(contrastRatio(bg, rgb(onColor(bg))), `${r},${g},${b}`).toBeGreaterThanOrEqual(AA.text)
        }
  })
})

describe('readableOn', () => {
  it('leaves colours that are already readable untouched', () => {
    const c = rgb('#a78bfa')
    expect(readableOn(c)).toBe(c)
  })
  it('lightens dark colours until they pass on every surface, keeping the hue order', () => {
    const fixed = readableOn(rgb('#101040'))
    for (const s of SURFACES) expect(contrastRatio(fixed, s)).toBeGreaterThanOrEqual(AA.text)
    expect(fixed[2]).toBeGreaterThan(fixed[0])
    expect(fixed[0]).toBe(fixed[1])
  })
  it('handles pure black', () => {
    const fixed = readableOn([0, 0, 0])
    for (const s of SURFACES) expect(contrastRatio(fixed, s)).toBeGreaterThanOrEqual(AA.text)
  })
  it('changes as little as needed', () => {
    const fixed = readableOn(rgb('#101040'))
    const worst = Math.min(...SURFACES.map((s) => contrastRatio(fixed, s)))
    expect(worst).toBeLessThan(AA.text + 0.2)
  })
})

describe('accentTheme', () => {
  it('rejects invalid input', () => {
    expect(accentTheme('purple')).toBeNull()
  })
  it('keeps the default accent as chosen', () => {
    expect(accentTheme('#a78bfa')).toEqual({ accent: '#a78bfa', on: '#000000', adjusted: false })
  })
  it('flags and fixes colours that were too dark', () => {
    const t = accentTheme('#000000')
    expect(t?.adjusted).toBe(true)
    expect(t?.on).toBe('#000000')
  })
  it('every preset is readable as text and carries readable text when filled', () => {
    for (const [, hex] of ACCENT_PRESETS) {
      const t = accentTheme(hex)
      expect(t?.adjusted, hex).toBe(false)
      for (const s of SURFACES) expect(contrastRatio(rgb(hex), s), hex).toBeGreaterThanOrEqual(AA.text)
      expect(contrastRatio(rgb(hex), rgb(t?.on ?? '#000000')), hex).toBeGreaterThanOrEqual(AA.text)
    }
  })
})

describe('theme text colours', () => {
  // The Tailwind greys the interface uses for text, measured on the surfaces they appear on.
  const text = { 'zinc-200': '#e4e4e7', 'zinc-300': '#d4d4d8', 'zinc-400': '#a1a1aa', 'zinc-500': '#71717a', 'zinc-600': '#52525b' }
  it('zinc-400 and lighter are safe for body text on every surface', () => {
    for (const name of ['zinc-200', 'zinc-300', 'zinc-400'] as const)
      for (const s of SURFACES) expect(contrastRatio(rgb(text[name]), s), name).toBeGreaterThanOrEqual(AA.text)
  })
  it('documents why zinc-500 and zinc-600 are not used for text', () => {
    const panel = SURFACES[1] as Rgb
    expect(contrastRatio(rgb(text['zinc-500']), panel)).toBeLessThan(AA.text)
    expect(contrastRatio(rgb(text['zinc-600']), panel)).toBeLessThan(AA.largeText)
  })
})
