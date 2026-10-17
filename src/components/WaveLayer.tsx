import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { RefObject } from 'react'
import { barsFor, paintBars } from '../lib/waveform/draw'
import type { Bar, Palette } from '../lib/waveform/draw'
import { peaksService, pruneOnce } from '../lib/waveform/instance'
import { paletteFor } from '../lib/waveform/palette'
import { seekStyle } from '../lib/waveform/prefs'
import { formatTime } from '../lib/format'
import type { PlayerApi } from '../types'

/**
 * The drawing behind the seek bar. The seek bar itself is, and stays, the native range input of `PlayerBar.tsx` (keyboard,
 * touch, screen readers, every test that drives it); this only adds what the file looks like, in two canvases: the whole
 * waveform in a quiet colour and the same in the accent colour, clipped to the part already played by CSS from the `--p`
 * the wrapper carries, so nothing is redrawn as playback moves. Loaded lazily; until it arrives, and when the person chose
 * the plain bar, the page looks exactly as it did before.
 */

interface WaveLayerProps {
  p: PlayerApi
  /** The `.seek` wrapper this layer sits in: it gets `data-wave` ("on" or "off") and `data-peaks` (the state of the measuring). */
  box: RefObject<HTMLDivElement | null>
}

const readAccent = (): string => getComputedStyle(document.documentElement).getPropertyValue('--accent-hex')

function useForcedColors(): boolean {
  const [forced, setForced] = useState(() => window.matchMedia('(forced-colors: active)').matches)
  useEffect(() => {
    const query = window.matchMedia('(forced-colors: active)')
    const update = () => setForced(query.matches)
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  return forced
}

/** The accent colour the page uses now: it changes when the person picks another, which restyles the root element. */
function useAccent(): string {
  const [accent, setAccent] = useState(readAccent)
  useEffect(() => {
    const watch = new MutationObserver(() => setAccent(readAccent()))
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] })
    return () => watch.disconnect()
  }, [])
  return accent
}

function paint(canvas: HTMLCanvasElement | null, bars: readonly Bar[], width: number, height: number, palette: Palette): void {
  const ctx = canvas?.getContext('2d')
  if (!canvas || !ctx) return
  const ratio = window.devicePixelRatio || 1
  canvas.width = Math.round(width * ratio)
  canvas.height = Math.round(height * ratio)
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
  paintBars(ctx, bars, width, height, palette)
}

export default function WaveLayer({ p, box }: WaveLayerProps) {
  const style = useSyncExternalStore(seekStyle.subscribe, seekStyle.get)
  const { current: track, duration, hydrated } = p
  const id = track?.id ?? ''
  const file = track?.file
  const trackDuration = track?.duration ?? 0
  const format = track?.audio ?? null

  // what the service needs to know; the same object while the track is the same
  const target = useMemo(() => (file ? { id, file, duration: trackDuration, format } : null), [id, file, trackDuration, format])
  useEffect(() => {
    peaksService.want(style === 'waveform' ? target : null)
  }, [style, target])
  const state = useSyncExternalStore(peaksService.subscribe, useCallback(() => peaksService.getState(id), [id]))

  useEffect(() => {
    if (hydrated) pruneOnce(new Set(p.tracks.map((t) => t.id)))
  }, [hydrated]) // eslint-disable-line react-hooks/exhaustive-deps

  // tell the page's CSS (and the tests) what this layer is doing: whether it draws, and how the measuring is going
  useEffect(() => {
    const el = box.current
    if (!el) return undefined
    el.dataset.wave = style === 'waveform' ? 'on' : 'off'
    return () => {
      delete el.dataset.wave
    }
  }, [box, style])
  useEffect(() => {
    const el = box.current
    if (!el || style !== 'waveform') return undefined
    el.dataset.peaks = state.status
    return () => {
      delete el.dataset.peaks
    }
  }, [box, style, state.status])

  const [size, setSize] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = box.current
    if (!el || style !== 'waveform') return undefined
    const measure = () => setSize((now) => (now.w === el.clientWidth && now.h === el.clientHeight ? now : { w: el.clientWidth, h: el.clientHeight }))
    measure()
    const watch = new ResizeObserver(measure)
    watch.observe(el)
    return () => watch.disconnect()
  }, [box, style])

  const accent = useAccent()
  const forced = useForcedColors()
  const base = useRef<HTMLCanvasElement>(null)
  const played = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    if (style !== 'waveform' || !size.w || !size.h) return
    const bars = barsFor(state.status === 'ready' ? state.peaks : null, size.w)
    const palette = paletteFor(accent, forced)
    paint(base.current, bars, size.w, size.h, palette.base)
    paint(played.current, bars, size.w, size.h, palette.played)
  }, [style, size, state, accent, forced])

  // the time under the pointer, as a small label above the bar (the slider itself speaks the time for screen readers)
  const [hover, setHover] = useState<{ x: number; t: number } | null>(null)
  useEffect(() => {
    const el = box.current
    if (!el || style !== 'waveform') return undefined
    const move = (event: PointerEvent) => {
      const rect = el.getBoundingClientRect()
      if (rect.width <= 0) return
      const x = Math.min(rect.width, Math.max(0, event.clientX - rect.left))
      setHover({ x, t: (x / rect.width) * duration })
    }
    const leave = () => setHover(null)
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerleave', leave)
    el.addEventListener('pointercancel', leave)
    return () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerleave', leave)
      el.removeEventListener('pointercancel', leave)
    }
  }, [box, style, duration])

  if (style !== 'waveform') return null
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0">
      <canvas ref={base} className="absolute inset-0 h-full w-full" />
      <canvas ref={played} className="absolute inset-0 h-full w-full" style={{ clipPath: 'inset(0 calc(100% - var(--p, 0%)) 0 0)' }} />
      {hover && duration > 0 && (
        <span className="absolute -top-6 -translate-x-1/2 rounded bg-black/80 px-1.5 py-0.5 text-[11px] tabular-nums text-zinc-100" style={{ left: hover.x }}>
          {formatTime(hover.t)}
        </span>
      )}
    </div>
  )
}
