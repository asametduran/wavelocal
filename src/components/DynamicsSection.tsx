import { useEffect, useMemo, useRef } from 'react'
import { Activity, Columns2, SlidersVertical } from 'lucide-react'
import RangeRow from './RangeRow'
import {
  ATTACK_RANGE_MS,
  CEILING_RANGE,
  KNEE_RANGE,
  MAKEUP_RANGE,
  RATIO_RANGE,
  RELEASE_RANGE_MS,
  THRESHOLD_RANGE,
  TONE_LIMIT,
  WIDTH_RANGE,
  describeStereo,
  transferCurve,
} from '../lib/dynamics'
import type { CompressorSettings, PlayerApi } from '../types'

const chip = (on: boolean) =>
  `rounded-full px-3 py-1.5 text-sm font-semibold transition ${on ? 'bg-accent text-black' : 'bg-white/10 text-zinc-200 hover:bg-white/15'}`

const signed = (v: number, digits = 1) => `${v > 0 ? '+' : ''}${v.toFixed(digits)} dB`

function Switch({ on, label, onToggle }: { on: boolean; label: string; onToggle: () => void }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      onClick={onToggle}
      className={`relative h-7 w-12 shrink-0 rounded-full transition ${on ? 'bg-accent' : 'bg-white/15'}`}
      aria-label={label}
    >
      <span className={`absolute top-1 h-5 w-5 rounded-full bg-white transition-all ${on ? 'left-6' : 'left-1'}`} />
    </button>
  )
}

const METER_RANGE_DB = 24

/** Gain-reduction read-out. It follows the audio clock with its own animation loop instead of re-rendering React. */
function ReductionMeter({ read, active, label }: { read: () => number; active: boolean; label: string }) {
  const bar = useRef<HTMLDivElement>(null)
  const text = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    let raf = 0
    const tick = () => {
      const db = active ? Math.min(0, read()) : 0
      if (bar.current) bar.current.style.width = `${Math.min(100, (-db / METER_RANGE_DB) * 100)}%`
      if (text.current) text.current.textContent = `${db.toFixed(1)} dB`
      raf = requestAnimationFrame(tick)
    }
    tick()
    return () => cancelAnimationFrame(raf)
  }, [read, active])

  return (
    <div className="flex items-center gap-3" role="group" aria-label={label}>
      <span className="w-20 shrink-0 text-xs text-zinc-400">Reduction</span>
      <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-white/10" aria-hidden="true">
        <div ref={bar} className="h-full w-0 rounded-full bg-accent" />
      </div>
      <span ref={text} className="w-14 shrink-0 text-right text-xs tabular-nums text-zinc-200">
        0.0 dB
      </span>
    </div>
  )
}

const CURVE = 120
const curveXY = (inDb: number, outDb: number) => [((inDb + 60) / 60) * CURVE, CURVE - ((Math.max(-60, Math.min(0, outDb)) + 60) / 60) * CURVE] as const

/** Static input/output curve of the compressor, including make-up gain. */
function CompressorCurve({ c }: { c: CompressorSettings }) {
  const points = useMemo(() => {
    const t = transferCurve(c)
    return Array.from(t.input, (x, i) => curveXY(x, t.output[i] ?? x).map((v) => v.toFixed(1)).join(',')).join(' ')
  }, [c])
  const [thresholdX] = curveXY(c.threshold, c.threshold)
  return (
    <svg
      viewBox={`0 0 ${CURVE} ${CURVE}`}
      role="img"
      aria-label={`Compressor curve: threshold ${c.threshold.toFixed(0)} dB, ratio ${c.ratio.toFixed(1)} to 1`}
      className="h-28 w-28 shrink-0 rounded-lg bg-base/60"
    >
      <line x1={0} y1={CURVE} x2={CURVE} y2={0} className="stroke-white/20" strokeDasharray="3 3" strokeWidth={1} />
      <line x1={thresholdX} y1={0} x2={thresholdX} y2={CURVE} className="stroke-white/15" strokeWidth={1} />
      <polyline points={points} className="fill-none stroke-accent" strokeWidth={2} strokeLinejoin="round" />
    </svg>
  )
}

/** Tone, stereo width, compressor and limiter. */
export default function DynamicsSection({ p }: { p: PlayerApi }) {
  const { dynamics: d, stereo, tone, setDynamics, setStereo, setTone, engine } = p
  const c = d.compressor
  const l = d.limiter
  const readCompressor = () => engine.compressorReduction()
  const readLimiter = () => engine.limiterReduction()

  return (
    <>
      <section aria-label="Tone" className="mt-6">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-zinc-400">
            <SlidersVertical size={15} /> Tone
          </h3>
          <button onClick={() => setTone({ bass: 0, treble: 0 })} disabled={tone.bass === 0 && tone.treble === 0} className={`${chip(false)} !py-1 disabled:opacity-40`}>
            Reset
          </button>
        </div>
        <div className="flex flex-col gap-3">
          <RangeRow label="Bass" value={tone.bass} min={-TONE_LIMIT} max={TONE_LIMIT} step={0.5} display={signed(tone.bass)} onChange={(bass) => setTone({ bass })} />
          <RangeRow label="Treble" value={tone.treble} min={-TONE_LIMIT} max={TONE_LIMIT} step={0.5} display={signed(tone.treble)} onChange={(treble) => setTone({ treble })} />
        </div>
      </section>

      <section aria-label="Stereo" className="mt-6">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-zinc-400">
            <Columns2 size={15} /> Stereo
          </h3>
          <label className="flex items-center gap-2 text-sm text-zinc-300">
            Mono downmix
            <Switch on={stereo.mono} label="Mono downmix" onToggle={() => setStereo({ mono: !stereo.mono })} />
          </label>
        </div>
        <RangeRow
          label="Width"
          ariaLabel="Stereo width"
          value={stereo.width}
          min={WIDTH_RANGE.min}
          max={WIDTH_RANGE.max}
          step={0.01}
          display={describeStereo(stereo)}
          disabled={stereo.mono}
          onChange={(width) => setStereo({ width })}
        />
        <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="Stereo width presets">
          {[
            ['Narrow', 0.5],
            ['Original', 1],
            ['Wide', 1.5],
            ['Extra wide', 2],
          ].map(([name, width]) => (
            <button key={name} disabled={stereo.mono} onClick={() => setStereo({ width: Number(width) })} className={`${chip(!stereo.mono && stereo.width === width)} disabled:opacity-40`} aria-pressed={!stereo.mono && stereo.width === width}>
              {name}
            </button>
          ))}
        </div>
      </section>

      <section aria-label="Compressor" className="mt-6">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-zinc-400">
            <Activity size={15} /> Compressor
          </h3>
          <Switch on={c.enabled} label="Enable compressor" onToggle={() => setDynamics({ compressor: { enabled: !c.enabled } })} />
        </div>
        <div className={`flex flex-col gap-4 transition-opacity sm:flex-row sm:items-start ${c.enabled ? '' : 'opacity-50'}`}>
          <div className="flex shrink-0 flex-col items-center gap-2 self-center">
            <CompressorCurve c={c} />
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            <RangeRow label="Threshold" ariaLabel="Compressor threshold" value={c.threshold} min={THRESHOLD_RANGE.min} max={THRESHOLD_RANGE.max} step={1} display={`${c.threshold.toFixed(0)} dB`} disabled={!c.enabled} onChange={(threshold) => setDynamics({ compressor: { threshold } })} />
            <RangeRow label="Ratio" ariaLabel="Compressor ratio" value={c.ratio} min={RATIO_RANGE.min} max={RATIO_RANGE.max} step={0.5} display={`${c.ratio.toFixed(1)}:1`} disabled={!c.enabled} onChange={(ratio) => setDynamics({ compressor: { ratio } })} />
            <RangeRow label="Attack" ariaLabel="Compressor attack" value={c.attack} min={ATTACK_RANGE_MS.min} max={ATTACK_RANGE_MS.max} step={1} display={`${c.attack.toFixed(0)} ms`} disabled={!c.enabled} onChange={(attack) => setDynamics({ compressor: { attack } })} />
            <RangeRow label="Release" ariaLabel="Compressor release" value={c.release} min={RELEASE_RANGE_MS.min} max={RELEASE_RANGE_MS.max} step={5} display={`${c.release.toFixed(0)} ms`} disabled={!c.enabled} onChange={(release) => setDynamics({ compressor: { release } })} />
            <RangeRow label="Knee" ariaLabel="Compressor knee" value={c.knee} min={KNEE_RANGE.min} max={KNEE_RANGE.max} step={1} display={`${c.knee.toFixed(0)} dB`} disabled={!c.enabled} onChange={(knee) => setDynamics({ compressor: { knee } })} />
            <RangeRow label="Makeup" ariaLabel="Compressor makeup gain" value={c.makeup} min={MAKEUP_RANGE.min} max={MAKEUP_RANGE.max} step={0.5} display={signed(c.makeup)} disabled={!c.enabled} onChange={(makeup) => setDynamics({ compressor: { makeup } })} />
            <ReductionMeter read={readCompressor} active={c.enabled} label="Compressor gain reduction" />
          </div>
        </div>
      </section>

      <section aria-label="Limiter" className="mt-6">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-zinc-400">Limiter</h3>
          <Switch on={l.enabled} label="Enable limiter" onToggle={() => setDynamics({ limiter: { enabled: !l.enabled } })} />
        </div>
        <div className={`flex flex-col gap-3 transition-opacity ${l.enabled ? '' : 'opacity-50'}`}>
          <RangeRow label="Ceiling" ariaLabel="Limiter ceiling" value={l.ceiling} min={CEILING_RANGE.min} max={CEILING_RANGE.max} step={0.5} display={`${l.ceiling.toFixed(1)} dB`} disabled={!l.enabled} onChange={(ceiling) => setDynamics({ limiter: { ceiling } })} />
          <ReductionMeter read={readLimiter} active={l.enabled} label="Limiter gain reduction" />
          <p className="text-xs text-zinc-500">Holds the final output under the ceiling, so EQ boosts, width and reverb cannot clip.</p>
        </div>
      </section>
    </>
  )
}
