import type { Palette } from './draw'

/**
 * The colours of the waveform: what has been played in the accent colour, what is still to come in a quiet neutral. A canvas
 * cannot use CSS variables, so the component reads the accent (`--accent-hex`) and asks for the colours here. In forced-colours
 * mode (Windows High Contrast) a canvas is not recoloured for the person, so the system colours are used, as they are for text.
 */

const DEFAULT_ACCENT = '#a78bfa'

export interface WavePalette {
  /** What is still to come. */
  base: Palette
  /** What has been played. */
  played: Palette
  /** The lines that tell where a chapter begins, drawn over both. */
  marks: string
}

function rgb(hex: string): [number, number, number] | null {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
  const digits = match?.[1]
  if (!digits) return null
  const full = digits.length === 3 ? [...digits].map((d) => d + d).join('') : digits
  return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)]
}

export function paletteFor(accent: string | null | undefined, forcedColors: boolean): WavePalette {
  if (forcedColors) return { base: { peak: 'GrayText', body: 'CanvasText' }, played: { peak: 'Highlight', body: 'Highlight' }, marks: 'CanvasText' }
  const [r, g, b] = (accent ? rgb(accent) : null) ?? rgb(DEFAULT_ACCENT) ?? [167, 139, 250]
  return {
    base: { peak: 'rgba(255, 255, 255, 0.22)', body: 'rgba(255, 255, 255, 0.42)' },
    played: { peak: `rgba(${r}, ${g}, ${b}, 0.5)`, body: `rgb(${r}, ${g}, ${b})` },
    marks: 'rgba(255, 255, 255, 0.7)',
  }
}
