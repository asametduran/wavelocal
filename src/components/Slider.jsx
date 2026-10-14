/** Styled range input with a filled track. */
export default function Slider({ value, max = 1, step = 0.001, onChange, label, className = '' }) {
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
      style={{ '--p': `${pct}%` }}
      onChange={(e) => onChange(parseFloat(e.target.value))}
      onPointerUp={(e) => e.currentTarget.blur()}
    />
  )
}
