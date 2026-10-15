// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { IDLE, TOOLTIP_LIMIT, buildTrayMenu, cleanText, parseCommand, parseNowPlaying, tooltipFor } from './tray-model'
import type { TrayActions } from './tray-model'
import { renderTrayIcon } from './tray-icon'
import { DEFAULT_SETTINGS, parseDesktopSettings } from './settings'

const BIDI = String.fromCharCode(0x202e)
const NUL = String.fromCharCode(0)

describe('cleanText', () => {
  it('trims, and turns control characters and bidi overrides into single spaces', () => {
    expect(cleanText(`  a${NUL}${NUL}b\n\tc${BIDI}d  `)).toBe('a b c d')
  })
  it('clips long text with an ellipsis', () => {
    const out = cleanText('x'.repeat(500))
    expect(out).toHaveLength(200)
    expect(out.endsWith('…')).toBe(true)
  })
  it('keeps unicode text intact', () => {
    expect(cleanText('Sigur Rós — Hoppípolla 🎵')).toBe('Sigur Rós — Hoppípolla 🎵')
  })
  it('returns an empty string for non-strings', () => {
    for (const v of [undefined, null, 5, {}, ['a']]) expect(cleanText(v)).toBe('')
  })
})

describe('parseNowPlaying', () => {
  it('accepts a well-formed state', () => {
    expect(parseNowPlaying({ title: 'Song', artist: 'Band', playing: true })).toEqual({ title: 'Song', artist: 'Band', playing: true })
  })
  it('treats anything malformed, or without a title, as idle', () => {
    for (const v of [null, undefined, 'x', 7, [], {}, { title: '' }, { title: '   ' }, { title: 5 }]) expect(parseNowPlaying(v)).toEqual(IDLE)
  })
  it('only treats a literal true as playing', () => {
    expect(parseNowPlaying({ title: 'a', playing: 'true' }).playing).toBe(false)
    expect(parseNowPlaying({ title: 'a', playing: 1 }).playing).toBe(false)
  })
  it('cleans hostile tag text', () => {
    expect(parseNowPlaying({ title: `evil${BIDI}track`, artist: 7 })).toEqual({ title: 'evil track', artist: '', playing: false })
  })
})

describe('parseCommand', () => {
  it('accepts exactly the three commands', () => {
    for (const c of ['toggle', 'next', 'prev'] as const) expect(parseCommand(c)).toBe(c)
  })
  it.each([['play'], [''], [null], [undefined], [1], ['TOGGLE'], ['quit'], [{ toString: () => 'next' }]])('rejects %j', (v) => {
    expect(parseCommand(v)).toBeNull()
  })
})

describe('tooltipFor', () => {
  it('is the app name when idle', () => {
    expect(tooltipFor(IDLE)).toBe('Wavelocal')
  })
  it('shows title and artist while playing, with a pause mark when paused', () => {
    expect(tooltipFor({ title: 'Song', artist: 'Band', playing: true })).toBe('Song — Band')
    expect(tooltipFor({ title: 'Song', artist: 'Band', playing: false })).toBe('⏸ Song — Band')
    expect(tooltipFor({ title: 'Song', artist: '', playing: true })).toBe('Song')
  })
  it('stays under the Windows limit, dropping the artist before the title', () => {
    for (const state of [
      { title: 'T'.repeat(200), artist: 'A'.repeat(200), playing: true },
      { title: 'T'.repeat(120), artist: 'A'.repeat(30), playing: false },
      { title: 'short', artist: 'A'.repeat(300), playing: true },
    ]) {
      expect(tooltipFor(state).length).toBeLessThan(TOOLTIP_LIMIT)
    }
    expect(tooltipFor({ title: 'short', artist: 'A'.repeat(300), playing: true })).toBe('short')
  })
})

describe('buildTrayMenu', () => {
  const actions = (): TrayActions => ({ command: vi.fn(), toggleWindow: vi.fn(), setCloseToTray: vi.fn(), quit: vi.fn() })
  const labels = (items: ReturnType<typeof buildTrayMenu>) => items.filter((i) => i.type !== 'separator').map((i) => i.label)

  it('disables transport while nothing is loaded', () => {
    const items = buildTrayMenu({ state: IDLE, windowVisible: true, closeToTray: true }, actions())
    expect(labels(items)).toEqual(['Nothing playing', 'Play', 'Next', 'Previous', 'Hide Wavelocal', 'Close to tray', 'Quit Wavelocal'])
    expect(items.filter((i) => ['Play', 'Next', 'Previous'].includes(i.label ?? '')).every((i) => i.enabled === false)).toBe(true)
  })

  it('reflects the track, the playing state and the window visibility', () => {
    const items = buildTrayMenu({ state: { title: 'Song', artist: 'Band', playing: true }, windowVisible: false, closeToTray: false }, actions())
    expect(labels(items)).toEqual(['Song — Band', 'Pause', 'Next', 'Previous', 'Show Wavelocal', 'Close to tray', 'Quit Wavelocal'])
    expect(items.find((i) => i.label === 'Close to tray')?.checked).toBe(false)
    expect(items.find((i) => i.label === 'Next')?.enabled).toBe(true)
  })

  it('wires every entry to its action', () => {
    const a = actions()
    const items = buildTrayMenu({ state: { title: 'Song', artist: '', playing: false }, windowVisible: true, closeToTray: true }, a)
    const click = (label: string, checked = false) => (items.find((i) => i.label === label)?.click as (item: { checked: boolean }) => void)({ checked })
    click('Play')
    click('Next')
    click('Previous')
    click('Hide Wavelocal')
    click('Close to tray', false)
    click('Quit Wavelocal')
    expect(vi.mocked(a.command).mock.calls).toEqual([['toggle'], ['next'], ['prev']])
    expect(a.toggleWindow).toHaveBeenCalledOnce()
    expect(a.setCloseToTray).toHaveBeenCalledWith(false)
    expect(a.quit).toHaveBeenCalledOnce()
  })

  it('clips a very long header', () => {
    const items = buildTrayMenu({ state: { title: 'T'.repeat(300), artist: 'A', playing: true }, windowVisible: true, closeToTray: true }, actions())
    expect(items[0]?.label?.length).toBeLessThanOrEqual(60)
  })
})

describe('renderTrayIcon', () => {
  const pixel = (bmp: Buffer, size: number, x: number, y: number) => {
    const o = (y * size + x) * 4
    return { b: bmp[o]!, g: bmp[o + 1]!, r: bmp[o + 2]!, a: bmp[o + 3]! }
  }

  it.each([16, 32, 64])('draws a %ipx BGRA bitmap', (size) => {
    const bmp = renderTrayIcon(size)
    expect(bmp.length).toBe(size * size * 4)
    expect(pixel(bmp, size, 0, 0).a).toBe(0) // transparent corner
    expect(pixel(bmp, size, size - 1, size - 1).a).toBe(0)
    expect(pixel(bmp, size, Math.floor(size / 2), 2).a).toBeGreaterThan(0) // inside the disc, below its small margin
    // premultiplied: no colour channel can exceed alpha
    for (let o = 0; o < bmp.length; o += 4) expect(Math.max(bmp[o]!, bmp[o + 1]!, bmp[o + 2]!)).toBeLessThanOrEqual(bmp[o + 3]!)
  })

  it('has an accent disc with a white triangle in the middle', () => {
    const size = 64
    const bmp = renderTrayIcon(size)
    expect(pixel(bmp, size, 8, 32)).toMatchObject({ a: 255, r: 124, g: 92, b: 255 })
    expect(pixel(bmp, size, 36, 32)).toMatchObject({ a: 255, r: 255, g: 255, b: 255 })
  })

  it('is deterministic and rejects silly sizes', () => {
    expect(renderTrayIcon(16).equals(renderTrayIcon(16))).toBe(true)
    for (const s of [0, 4, 7.5, 1024, NaN]) expect(() => renderTrayIcon(s)).toThrow(RangeError)
  })
})

describe('parseDesktopSettings', () => {
  it('defaults to closing to the tray', () => {
    expect(DEFAULT_SETTINGS.closeToTray).toBe(true)
    for (const v of [null, undefined, 'x', 3, [], {}, { closeToTray: 'no' }, { closeToTray: 0 }]) expect(parseDesktopSettings(v)).toEqual(DEFAULT_SETTINGS)
  })
  it('reads an explicit choice and ignores unknown fields', () => {
    expect(parseDesktopSettings({ closeToTray: false, extra: 1 })).toMatchObject({ closeToTray: false })
    expect(parseDesktopSettings({ closeToTray: true })).toMatchObject({ closeToTray: true })
  })
})
