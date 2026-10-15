import { useEffect, useMemo, useRef } from 'react'
import type { KeyboardEvent, PointerEvent } from 'react'
import {
  FREQ_MAX,
  FREQ_MIN,
  GAIN_LIMIT,
  GRAPHIC_FREQS,
  Q_MAX,
  Q_MIN,
  bandTypeInfo,
  describeBand,
  formatFrequency,
  freqToPos,
  posToFreq,
  responseCurve,
} from '../lib/eq'
import type { EqBand } from '../types'

const W = 600
const H = 220
const PL = 38
const PR = 12
const PT = 10
const PB = 20
const PLOT_W = W - PL - PR
const PLOT_H = H - PT - PB
const DB_RANGE = 15 // the plot shows +-15 dB; bands are limited to +-12

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const xOf = (frequency: number) => PL + freqToPos(frequency) * PLOT_W
const yOf = (db: number) => PT + ((DB_RANGE - clamp(db, -DB_RANGE, DB_RANGE)) / (2 * DB_RANGE)) * PLOT_H
const round1 = (v: number) => Math.round(v * 10) / 10
const round2 = (v: number) => Math.round(v * 100) / 100

interface EqCurveProps {
  bands: readonly EqBand[]
  /** When false the equalizer is bypassed: the curve is drawn dimmed. */
  enabled: boolean
  selectedId: string | null
  onSelect: (id: string) => void
  onChange: (id: string, patch: Partial<Omit<EqBand, 'id'>>) => void
  onRemove: (id: string) => void
  /** Double-click on empty space adds a band there. */
  onAddAt: (frequency: number, gain: number) => void
}

/**
 * Interactive frequency-response editor. Drag a handle to change a band's frequency (horizontal) and gain
 * (vertical); scroll over a handle to change its Q; double-click empty space to add a band, a handle to flatten it.
 * Keyboard: arrows move the focused band (Shift = larger steps), +/- change Q, Delete removes it.
 */
export default function EqCurve({ bands, enabled, selectedId, onSelect, onChange, onRemove, onAddAt }: EqCurveProps) {
  const svg = useRef<SVGSVGElement>(null)
  const dragging = useRef<string | null>(null)
  // latest props for the native wheel listener (which must be registered once, as non-passive)
  const latest = useRef({ bands, onChange })
  latest.current = { bands, onChange }

  const { area, line } = useMemo(() => {
    const curve = responseCurve(bands, { points: 200 })
    const points = Array.from(curve.frequencies, (f, i) => `${xOf(f).toFixed(1)},${yOf(curve.db[i] ?? 0).toFixed(1)}`)
    const zero = yOf(0).toFixed(1)
    return { line: `M ${points.join(' L ')}`, area: `M ${xOf(FREQ_MIN).toFixed(1)},${zero} L ${points.join(' L ')} L ${xOf(FREQ_MAX).toFixed(1)},${zero} Z` }
  }, [bands])

  // wheel over a handle = Q; needs { passive: false } so the page does not scroll as well
  useEffect(() => {
    const el = svg.current
    if (!el) return undefined
    const onWheel = (e: WheelEvent) => {
      const target = e.target instanceof Element ? e.target.closest('[data-band-id]') : null
      const id = target?.getAttribute('data-band-id')
      const band = latest.current.bands.find((b) => b.id === id)
      if (!band || !bandTypeInfo(band.type).usesQ) return
      e.preventDefault()
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12
      latest.current.onChange(band.id, { q: round2(clamp(band.q * factor, Q_MIN, Q_MAX)) })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const toValues = (e: { clientX: number; clientY: number }) => {
    const rect = svg.current?.getBoundingClientRect()
    if (!rect || rect.width === 0 || rect.height === 0) return null
    const sx = ((e.clientX - rect.left) / rect.width) * W
    const sy = ((e.clientY - rect.top) / rect.height) * H
    return {
      frequency: Math.round(posToFreq((sx - PL) / PLOT_W)),
      gain: round1(clamp(DB_RANGE - ((sy - PT) / PLOT_H) * 2 * DB_RANGE, -GAIN_LIMIT, GAIN_LIMIT)),
    }
  }

  const onHandleDown = (e: PointerEvent<SVGGElement>, band: EqBand) => {
    e.stopPropagation()
    onSelect(band.id)
    dragging.current = band.id
    e.currentTarget.setPointerCapture(e.pointerId) // on the handle itself, so its double-click still reaches it
  }

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const id = dragging.current
    const band = bands.find((b) => b.id === id)
    const v = toValues(e)
    if (!id || !band || !v) return
    onChange(id, bandTypeInfo(band.type).usesGain ? { frequency: v.frequency, gain: v.gain } : { frequency: v.frequency })
  }

  const onKey = (e: KeyboardEvent<SVGGElement>, band: EqBand) => {
    const big = e.shiftKey
    const info = bandTypeInfo(band.type)
    let patch: Partial<Omit<EqBand, 'id'>> | null = null
    if (e.key === 'ArrowLeft') patch = { frequency: Math.round(band.frequency * 2 ** (-(big ? 4 : 1) / 12)) }
    else if (e.key === 'ArrowRight') patch = { frequency: Math.round(band.frequency * 2 ** ((big ? 4 : 1) / 12)) }
    else if (e.key === 'ArrowUp' && info.usesGain) patch = { gain: round1(band.gain + (big ? 2 : 0.5)) }
    else if (e.key === 'ArrowDown' && info.usesGain) patch = { gain: round1(band.gain - (big ? 2 : 0.5)) }
    else if ((e.key === '+' || e.key === '=' || e.key === 'PageUp') && info.usesQ) patch = { q: round2(band.q * 1.12) }
    else if ((e.key === '-' || e.key === '_' || e.key === 'PageDown') && info.usesQ) patch = { q: round2(band.q / 1.12) }
    else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      e.stopPropagation()
      onRemove(band.id)
      return
    }
    if (!patch) return
    e.preventDefault()
    e.stopPropagation() // the global hotkeys would otherwise also seek / change the volume
    onChange(band.id, patch)
  }

  const gridDb = [-12, -6, 0, 6, 12]

  return (
    <svg
      ref={svg}
      viewBox={`0 0 ${W} ${H}`}
      role="group"
      aria-label="Equalizer response curve"
      className={`w-full touch-none select-none rounded-xl bg-base/60 ${enabled ? '' : 'opacity-50'}`}
      onPointerMove={onMove}
      onPointerUp={() => (dragging.current = null)}
      onPointerCancel={() => (dragging.current = null)}
      onDoubleClick={(e) => {
        const v = toValues(e)
        if (v) onAddAt(v.frequency, v.gain)
      }}
      data-noswipe
    >
      <g aria-hidden="true">
        {GRAPHIC_FREQS.map((f) => (
          <g key={f}>
            <line x1={xOf(f)} x2={xOf(f)} y1={PT} y2={PT + PLOT_H} className="stroke-white/[0.07]" strokeWidth={1} />
            <text x={xOf(f)} y={H - 6} textAnchor="middle" className="fill-zinc-400 text-[9px]">
              {f >= 1000 ? `${f / 1000}k` : f}
            </text>
          </g>
        ))}
        {gridDb.map((db) => (
          <g key={db}>
            <line x1={PL} x2={PL + PLOT_W} y1={yOf(db)} y2={yOf(db)} className={db === 0 ? 'stroke-white/25' : 'stroke-white/[0.07]'} strokeWidth={1} />
            <text x={PL - 6} y={yOf(db) + 3} textAnchor="end" className="fill-zinc-400 text-[9px]">
              {db > 0 ? `+${db}` : db}
            </text>
          </g>
        ))}
        <path d={area} className="fill-accent/15" />
        <path d={line} className="fill-none stroke-accent" strokeWidth={2} strokeLinejoin="round" />
      </g>

      {bands.map((band, i) => {
        const info = bandTypeInfo(band.type)
        const selected = band.id === selectedId
        const cx = xOf(band.frequency)
        const cy = yOf(info.usesGain ? band.gain : 0)
        return (
          <g
            key={band.id}
            data-band-id={band.id}
            role="slider"
            tabIndex={0}
            aria-label={`Band ${i + 1}`}
            aria-valuemin={FREQ_MIN}
            aria-valuemax={FREQ_MAX}
            aria-valuenow={Math.round(band.frequency)}
            aria-valuetext={describeBand(band)}
            aria-current={selected ? 'true' : undefined}
            className="cursor-grab outline-none focus-visible:[&>circle:first-child]:stroke-white"
            onPointerDown={(e) => onHandleDown(e, band)}
            onFocus={() => onSelect(band.id)}
            onKeyDown={(e) => onKey(e, band)}
            onDoubleClick={(e) => {
              e.stopPropagation()
              if (info.usesGain) onChange(band.id, { gain: 0 })
            }}
          >
            <title>{`${describeBand(band)} (${formatFrequency(band.frequency)})`}</title>
            <circle cx={cx} cy={cy} r={selected ? 11 : 9} className={`${selected ? 'fill-accent stroke-white' : 'fill-base stroke-accent'}`} strokeWidth={2} />
            <text x={cx} y={cy + 3.5} textAnchor="middle" className={`pointer-events-none text-[10px] font-bold ${selected ? 'fill-on-accent' : 'fill-white'}`}>
              {i + 1}
            </text>
          </g>
        )
      })}
    </svg>
  )
}
