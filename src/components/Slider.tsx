import type { CSSProperties } from 'react'

interface SliderProps {
  value: number
  max?: number
  step?: number
  onChange: (value: number) => void
  label: string
  /** Spoken value ("1 minute 5 seconds") for screen readers; the raw number is meaningless for time and volume. */
  valueText?: string
  className?: string
}

/** Styled range input with a filled track. */
export default function Slider({ value, max = 1, step = 0.001, onChange, label, valueText, className = '' }: SliderProps) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0
  return (
    <input
      type="range"
      className={`slider w-full ${className}`}
      min={0}
      max={max || 1}
      step={step}
      value={Math.min(value, max || 1)}
      aria-label={label}
      aria-valuetext={valueText}
      style={{ '--p': `${pct}%` } as CSSProperties}
      onChange={(e) => onChange(parseFloat(e.target.value))}
      onPointerUp={(e) => e.currentTarget.blur()}
    />
  )
}
