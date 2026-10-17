// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { paletteFor } from './palette'

describe('paletteFor', () => {
  it('draws what has been played in the accent colour, its outline lighter than its body', () => {
    const { played } = paletteFor('#a78bfa', false)
    expect(played.body).toBe('rgb(167, 139, 250)')
    expect(played.peak).toBe('rgba(167, 139, 250, 0.5)')
  })

  it('draws what is still to come in a quiet neutral, whatever the accent', () => {
    const a = paletteFor('#a78bfa', false).base
    const b = paletteFor('#2dd4bf', false).base
    expect(a).toEqual(b)
    expect(a.peak).toMatch(/^rgba\(255, 255, 255, 0\.\d+\)$/)
    expect(a.body).toMatch(/^rgba\(255, 255, 255, 0\.\d+\)$/)
  })

  it('reads the short form of a hex colour', () => {
    expect(paletteFor('#fff', false).played.body).toBe('rgb(255, 255, 255)')
    expect(paletteFor('#0af', false).played.body).toBe('rgb(0, 170, 255)')
  })

  it('reads upper case and ignores surrounding space', () => {
    expect(paletteFor('  #2DD4BF ', false).played.body).toBe('rgb(45, 212, 191)')
  })

  it('falls back to the default accent for anything that is not a hex colour, so the waveform is never invisible', () => {
    const fallback = paletteFor('#a78bfa', false)
    for (const bad of ['', 'red', 'rgb(1,2,3)', '#12', '#12345', '#ggg', null, undefined]) expect(paletteFor(bad, false), String(bad)).toEqual(fallback)
  })

  it('draws the chapter marks in a light line that shows on both the quiet and the accent colour, whatever the accent', () => {
    const { marks } = paletteFor('#a78bfa', false)
    expect(marks).toMatch(/^rgba\(255, 255, 255, 0\.[6-9]\d*\)$/)
    expect(paletteFor('#2dd4bf', false).marks).toBe(marks)
  })

  it('shades a loop in the accent colour, with solid edges, and flags bookmarks in a colour that is not the accent and not white', () => {
    const { region, flag } = paletteFor('#a78bfa', false)
    expect(region).toEqual({ fill: 'rgba(167, 139, 250, 0.28)', edge: 'rgb(167, 139, 250)' })
    expect(flag).toBe('rgb(251, 191, 36)')
    expect(paletteFor('#2dd4bf', false).flag).toBe(flag) // the same amber for any accent
    expect(paletteFor('#2dd4bf', false).region.edge).toBe('rgb(45, 212, 191)')
  })

  it('uses the system colours in forced-colours mode, where a canvas is not recoloured for the person', () => {
    expect(paletteFor('#a78bfa', true)).toEqual({
      base: { peak: 'GrayText', body: 'CanvasText' },
      played: { peak: 'Highlight', body: 'Highlight' },
      marks: 'CanvasText',
      region: { fill: 'transparent', edge: 'Highlight' },
      flag: 'Highlight',
    })
  })
})
