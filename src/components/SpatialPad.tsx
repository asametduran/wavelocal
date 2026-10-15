import { useEffect, useRef } from 'react'
import type { KeyboardEvent, PointerEvent } from 'react'
import { azimuthDegrees, clampPad, describePosition } from '../lib/spatial'
import type { Point2 } from '../lib/spatial'

const SIZE = 176
const CENTER = SIZE / 2
const RADIUS = 74 // pad units -> pixels
const STEP = 0.05
const BIG_STEP = 0.2

interface SpatialPadProps {
  x: number
  y: number
  disabled?: boolean
  /** While the source orbits, returns its live position; polled each animation frame. Omit when static. */
  livePosition?: (() => Point2) | null
  onChange: (x: number, y: number) => void
}

/**
 * Top-down view of the listener (centre, facing up). Drag or use the arrow keys to place the sound;
 * Home/End/PageUp/PageDown jump to front / behind / right / left.
 */
export default function SpatialPad({ x, y, disabled = false, livePosition = null, onChange }: SpatialPadProps) {
  const dragging = useRef(false)
  const dot = useRef<SVGCircleElement>(null)
  const line = useRef<SVGLineElement>(null)

  const place = (p: Point2) => {
    const sx = CENTER + p.x * RADIUS
    const sy = CENTER + p.y * RADIUS
    dot.current?.setAttribute('cx', String(sx))
    dot.current?.setAttribute('cy', String(sy))
    line.current?.setAttribute('x2', String(sx))
    line.current?.setAttribute('y2', String(sy))
  }

  // static position: re-place on every prop change
  useEffect(() => {
    if (!livePosition) place({ x, y })
  }, [x, y, livePosition])

  // orbiting: follow the audio engine's clock without re-rendering React each frame
  useEffect(() => {
    if (!livePosition) return undefined
    let raf = 0
    const tick = () => {
      place(livePosition())
      raf = requestAnimationFrame(tick)
    }
    tick()
    return () => cancelAnimationFrame(raf)
  }, [livePosition])

  const fromPointer = (e: PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return
    const px = (((e.clientX - rect.left) / rect.width) * SIZE - CENTER) / RADIUS
    const py = (((e.clientY - rect.top) / rect.height) * SIZE - CENTER) / RADIUS
    const p = clampPad(px, py)
    onChange(p.x, p.y)
  }

  const onPointerDown = (e: PointerEvent<SVGSVGElement>) => {
    if (disabled) return
    dragging.current = true
    e.currentTarget.setPointerCapture(e.pointerId)
    e.currentTarget.focus()
    fromPointer(e)
  }

  const onKeyDown = (e: KeyboardEvent<SVGSVGElement>) => {
    if (disabled) return
    const step = e.shiftKey ? BIG_STEP : STEP
    const jump: Record<string, Point2 | undefined> = {
      Home: { x: 0, y: -1 },
      End: { x: 0, y: 1 },
      PageUp: { x: 1, y: 0 },
      PageDown: { x: -1, y: 0 },
    }
    const move: Record<string, Point2 | undefined> = {
      ArrowLeft: { x: -step, y: 0 },
      ArrowRight: { x: step, y: 0 },
      ArrowUp: { x: 0, y: -step },
      ArrowDown: { x: 0, y: step },
    }
    const target = jump[e.key] ?? (move[e.key] ? { x: x + (move[e.key]?.x ?? 0), y: y + (move[e.key]?.y ?? 0) } : undefined)
    if (!target) return
    e.preventDefault()
    e.stopPropagation() // arrows would otherwise also seek the track via the global hotkeys
    const p = clampPad(target.x, target.y)
    onChange(p.x, p.y)
  }

  const p = clampPad(x, y)
  const description = `${describePosition(p.x, p.y)}, ${Math.round(Math.hypot(p.x, p.y) * 100)}% out`

  return (
    <svg
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label="Sound position"
      aria-valuemin={0}
      aria-valuemax={359}
      aria-valuenow={Math.round(azimuthDegrees(p.x, p.y)) % 360}
      aria-valuetext={description}
      aria-disabled={disabled}
      className={`h-44 w-44 shrink-0 touch-none select-none rounded-full bg-base/60 outline-none focus-visible:ring-2 focus-visible:ring-accent ${disabled ? 'opacity-40' : 'cursor-crosshair'}`}
      onPointerDown={onPointerDown}
      onPointerMove={(e) => dragging.current && fromPointer(e)}
      onPointerUp={() => (dragging.current = false)}
      onPointerCancel={() => (dragging.current = false)}
      onKeyDown={onKeyDown}
      data-noswipe
    >
      <circle cx={CENTER} cy={CENTER} r={RADIUS} className="fill-none stroke-white/20" strokeWidth={1.5} />
      <circle cx={CENTER} cy={CENTER} r={RADIUS / 2} className="fill-none stroke-white/10" strokeWidth={1} strokeDasharray="3 4" />
      <line x1={CENTER} y1={CENTER - RADIUS} x2={CENTER} y2={CENTER + RADIUS} className="stroke-white/10" strokeWidth={1} />
      <line x1={CENTER - RADIUS} y1={CENTER} x2={CENTER + RADIUS} y2={CENTER} className="stroke-white/10" strokeWidth={1} />
      <g className="fill-zinc-400 text-[10px]" textAnchor="middle" aria-hidden="true">
        <text x={CENTER} y={11}>FRONT</text>
        <text x={CENTER} y={SIZE - 4}>BACK</text>
        <text x={9} y={CENTER + 3} textAnchor="start">L</text>
        <text x={SIZE - 9} y={CENTER + 3} textAnchor="end">R</text>
      </g>
      {/* the listener, facing up */}
      <circle cx={CENTER} cy={CENTER} r={9} className="fill-zinc-600" />
      <path d={`M ${CENTER - 4} ${CENTER - 8} L ${CENTER} ${CENTER - 16} L ${CENTER + 4} ${CENTER - 8} Z`} className="fill-zinc-600" />
      <line ref={line} x1={CENTER} y1={CENTER} x2={CENTER} y2={CENTER - RADIUS} className="stroke-accent/50" strokeWidth={1.5} />
      <circle ref={dot} cx={CENTER} cy={CENTER - RADIUS} r={8} className="fill-accent stroke-white" strokeWidth={2} />
    </svg>
  )
}
