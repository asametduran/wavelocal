import type { CSSProperties } from 'react'

interface RangeRowProps {
  /** Visible short label. */
  label: string
  /** Accessible name when the visible label is not specific enough on its own. */
  ariaLabel?: string
  value: number
  min: number
  max: number
  step: number
  /** Formatted current value shown on the right. */
  display: string
  disabled?: boolean
  onChange: (value: number) => void
}

/** Label, filled range slider and value read-out on one line, used by the sound-tools sections. */
export default function RangeRow({ label, ariaLabel, value, min, max, step, display, disabled = false, onChange }: RangeRowProps) {
  const pct = ((value - min) / (max - min)) * 100
  return (
    <div className={`flex items-center gap-3 ${disabled ? 'opacity-40' : ''}`}>
      <span className="w-20 shrink-0 text-xs text-zinc-400">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-label={ariaLabel ?? label}
        aria-valuetext={display}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="slider always min-w-0 flex-1"
        style={{ '--p': `${pct}%` } as CSSProperties}
      />
      <span className="w-14 shrink-0 text-right text-xs tabular-nums text-zinc-200">{display}</span>
    </div>
  )
}
