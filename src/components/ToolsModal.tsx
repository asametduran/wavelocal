import { Moon, Gauge, Palette, Shuffle as Blend, SlidersHorizontal, Volume2, X } from 'lucide-react'
import { ACCENT_PRESETS, DEFAULT_ACCENT } from '../hooks/useTheme'
import { EQ_LABELS, EQ_MAX_DB, EQ_PRESETS } from '../lib/engine'
import type { CSSProperties } from 'react'
import type { PlayerApi, TransitionMode } from '../types'

const TIMERS = [15, 30, 45, 60]
const MODES: readonly (readonly [id: TransitionMode, label: string, description: string])[] = [
  ['off', 'Off', 'Tracks play one after another.'],
  ['gapless', 'Gapless', 'The next track starts the instant this one ends.'],
  ['crossfade', 'Crossfade', 'Tracks blend into each other over ~5 seconds.'],
]
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
const same = (a: readonly number[], b: readonly number[]) => a.every((v, i) => v === b[i])

const chip = (on: boolean) =>
  `rounded-full px-4 py-2 text-sm font-semibold transition ${on ? 'bg-accent text-black' : 'bg-white/10 text-zinc-200 hover:bg-white/15'}`

/** Equalizer, sleep timer and transition settings. Bottom sheet on phones, centered dialog elsewhere. */
interface ToolsModalProps {
  p: PlayerApi
  open: boolean
  onClose: () => void
  accent: string
  setAccent: (hex: string) => void
}

export default function ToolsModal({ p, open, onClose, accent, setAccent }: ToolsModalProps) {
  if (!open) return null
  const activePreset = Object.keys(EQ_PRESETS).find((k) => same(EQ_PRESETS[k], p.eq))
  const mode = MODES.find((m) => m[0] === p.transition) || MODES[0]

  return (
    <div data-modal="true" role="dialog" aria-modal="true" aria-label="Sound and tools" className="fixed inset-0 z-[55] flex items-end justify-center md:items-center">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />
      <div className="relative max-h-[92dvh] w-full animate-fadeIn overflow-y-auto rounded-t-3xl bg-panel p-5 pb-safe shadow-2xl md:max-w-2xl md:rounded-3xl md:p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-lg font-bold">
            <SlidersHorizontal size={20} className="text-accent" /> Sound &amp; tools
          </h2>
          <button onClick={onClose} className="grid h-10 w-10 place-items-center rounded-full text-zinc-400 hover:bg-white/10 hover:text-white" aria-label="Close">
            <X size={20} />
          </button>
        </div>

        <section aria-label="Equalizer">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-zinc-400">Equalizer</h3>
            <button
              role="switch"
              aria-checked={p.eqOn}
              onClick={() => p.setEqOn(!p.eqOn)}
              className={`relative h-7 w-12 rounded-full transition ${p.eqOn ? 'bg-accent' : 'bg-white/15'}`}
              aria-label="Enable equalizer"
            >
              <span className={`absolute top-1 h-5 w-5 rounded-full bg-white transition-all ${p.eqOn ? 'left-6' : 'left-1'}`} />
            </button>
          </div>
          <div className="mb-4 flex flex-wrap gap-2">
            {Object.keys(EQ_PRESETS).map((name) => (
              <button key={name} onClick={() => p.applyPreset(name)} className={chip(activePreset === name)} aria-pressed={activePreset === name}>
                {name}
              </button>
            ))}
          </div>
          <div className={`flex justify-between gap-1 rounded-2xl bg-base/60 px-2 py-4 transition-opacity ${p.eqOn ? '' : 'opacity-40'}`}>
            {EQ_LABELS.map((label, i) => (
              <div key={label} className="flex flex-col items-center gap-2">
                <span className="w-9 text-center text-[11px] tabular-nums text-zinc-400">{p.eq[i] > 0 ? '+' : ''}{p.eq[i]}</span>
                <div className="relative h-36 w-9">
                  <input
                    type="range"
                    min={-EQ_MAX_DB}
                    max={EQ_MAX_DB}
                    step={0.5}
                    value={p.eq[i]}
                    onChange={(e) => p.setEqBand(i, parseFloat(e.target.value))}
                    onDoubleClick={() => p.setEqBand(i, 0)}
                    aria-label={`${label} Hz gain`}
                    className="slider always absolute left-1/2 top-1/2 w-36 -translate-x-1/2 -translate-y-1/2 -rotate-90"
                    style={{ '--p': `${((p.eq[i] + EQ_MAX_DB) / (EQ_MAX_DB * 2)) * 100}%` } as CSSProperties}
                  />
                </div>
                <span className="text-[11px] text-zinc-500">{label}</span>
              </div>
            ))}
          </div>
          <p className="mt-2 text-xs text-zinc-500">Double-click a band to reset it. Values are in dB.</p>
        </section>

        <section aria-label="Speed and pitch" className="mt-6">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-zinc-400">
              <Gauge size={15} /> Speed &amp; pitch
            </h3>
            <button onClick={() => p.setSpeed(1)} disabled={p.speed === 1} className={`${chip(false)} !py-1 disabled:opacity-40`}>
              Reset
            </button>
          </div>
          <div className="flex items-center gap-3">
            <input
              type="range"
              min={0.5}
              max={2}
              step={0.05}
              value={p.speed}
              onChange={(e) => p.setSpeed(parseFloat(e.target.value))}
              onDoubleClick={() => p.setSpeed(1)}
              aria-label="Playback speed"
              className="slider always flex-1"
              style={{ '--p': `${((p.speed - 0.5) / 1.5) * 100}%` } as CSSProperties}
            />
            <span className="w-14 text-right text-sm tabular-nums text-zinc-200">{p.speed.toFixed(2)}x</span>
          </div>
          <label className="mt-3 flex items-center justify-between text-sm text-zinc-300">
            Keep original pitch
            <button
              role="switch"
              aria-checked={p.preservePitch}
              onClick={() => p.setPreservePitch(!p.preservePitch)}
              className={`relative h-7 w-12 rounded-full transition ${p.preservePitch ? 'bg-accent' : 'bg-white/15'}`}
              aria-label="Keep original pitch"
            >
              <span className={`absolute top-1 h-5 w-5 rounded-full bg-white transition-all ${p.preservePitch ? 'left-6' : 'left-1'}`} />
            </button>
          </label>
          <p className="mt-2 text-xs text-zinc-500">Off gives a vinyl-style pitch shift as speed changes.</p>
        </section>

        <section aria-label="Accent color" className="mt-6">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-zinc-400">
              <Palette size={15} /> Accent color
            </h3>
            <button onClick={() => setAccent(DEFAULT_ACCENT)} disabled={accent === DEFAULT_ACCENT} className={`${chip(false)} !py-1 disabled:opacity-40`}>
              Reset
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {ACCENT_PRESETS.map(([name, hex]) => (
              <button
                key={hex}
                onClick={() => setAccent(hex)}
                aria-label={name}
                aria-pressed={accent === hex}
                className={`h-9 w-9 rounded-full border-2 transition ${accent === hex ? 'border-white' : 'border-transparent'}`}
                style={{ background: hex }}
              />
            ))}
            <label className="flex items-center gap-2 text-sm text-zinc-300">
              <input type="color" value={accent} onChange={(e) => setAccent(e.target.value)} aria-label="Custom accent color" className="h-9 w-12 cursor-pointer rounded bg-transparent" />
              Custom
            </label>
          </div>
        </section>

        <section aria-label="Sleep timer" className="mt-6">
          <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-zinc-400">
            <Moon size={15} /> Sleep timer
          </h3>
          <div className="flex flex-wrap gap-2">
            {TIMERS.map((m) => (
              <button key={m} onClick={() => p.setSleep(m)} className={chip(false)}>
                {m} min
              </button>
            ))}
            <button onClick={() => p.setSleep(null)} disabled={p.sleepLeft === null} className={`${chip(false)} disabled:opacity-40`}>
              Off
            </button>
          </div>
          {p.sleepLeft !== null && (
            <p className="mt-2 text-sm text-accent" role="status">
              Stopping in {fmt(p.sleepLeft)} — volume fades out over the final 12 seconds.
            </p>
          )}
        </section>

        <section aria-label="Track transitions" className="mt-6">
          <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-zinc-400">
            <Blend size={15} /> Transitions
          </h3>
          <div className="flex flex-wrap gap-2" role="radiogroup">
            {MODES.map(([id, label]) => (
              <button key={id} role="radio" aria-checked={p.transition === id} onClick={() => p.setTransition(id)} className={chip(p.transition === id)}>
                {label}
              </button>
            ))}
          </div>
          <p className="mt-2 text-xs text-zinc-500">{mode[2]}</p>
        </section>

        <section aria-label="Volume normalization" className="mt-6">
          <label className="flex items-center justify-between">
            <h3 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-zinc-400">
              <Volume2 size={15} /> Normalize volume
            </h3>
            <button
              role="switch"
              aria-checked={p.normalize}
              onClick={() => p.setNormalize(!p.normalize)}
              className={`relative h-7 w-12 rounded-full transition ${p.normalize ? 'bg-accent' : 'bg-white/15'}`}
              aria-label="Normalize volume between tracks"
            >
              <span className={`absolute top-1 h-5 w-5 rounded-full bg-white transition-all ${p.normalize ? 'left-6' : 'left-1'}`} />
            </button>
          </label>
          <p className="mt-2 text-xs text-zinc-500">
            Evens out loud and quiet tracks. Loudness is measured on your device the first time a track plays, then remembered
            {p.current?.gainDb != null && p.normalize ? ` (this track: ${p.current.gainDb > 0 ? '+' : ''}${p.current.gainDb} dB).` : '.'}
          </p>
        </section>
      </div>
    </div>
  )
}
