import { useRef } from 'react'
import { Accessibility, Moon, Gauge, Palette, Shuffle as Blend, SlidersHorizontal, Volume2, X } from 'lucide-react'
import { useDialog, useMotionPref, useReducedMotion } from '../hooks/useA11y'
import { ACCENT_PRESETS, DEFAULT_ACCENT } from '../hooks/useTheme'
import { accentTheme } from '../lib/contrast'
import type { MotionPref } from '../lib/motion'
import RovingGroup from './RovingGroup'
import BackupSection from './BackupSection'
import DynamicsSection from './DynamicsSection'
import EqSection from './EqSection'
import HotkeysSection from './HotkeysSection'
import LongFormSection from './LongFormSection'
import ReverbSection from './ReverbSection'
import ShareSection from './ShareSection'
import SpatialSection from './SpatialSection'
import SeekBarSection from './SeekBarSection'
import StorageSection from './StorageSection'
import type { CSSProperties } from 'react'
import type { PlayerApi, TransitionMode } from '../types'

const TIMERS = [15, 30, 45, 60]
const MODES: readonly (readonly [id: TransitionMode, label: string, description: string])[] = [
  ['off', 'Off', 'Tracks play one after another.'],
  ['gapless', 'Gapless', 'The next track starts the instant this one ends.'],
  ['crossfade', 'Crossfade', 'Tracks blend into each other over ~5 seconds.'],
]
const MOTION_OPTIONS: readonly (readonly [id: MotionPref, label: string])[] = [
  ['system', 'Follow device'],
  ['reduce', 'Reduce motion'],
  ['full', 'Full motion'],
]
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

const chip = (on: boolean) =>
  `rounded-full px-4 py-2 text-sm font-semibold transition ${on ? 'bg-accent text-on-accent' : 'bg-white/10 text-zinc-200 hover:bg-white/15'}`

interface ToolsModalProps {
  p: PlayerApi
  open: boolean
  onClose: () => void
  accent: string
  setAccent: (hex: string) => void
}

/** Sound tools: equalizer, spatial audio, reverb, speed, sleep timer and transitions. Bottom sheet on phones, centered dialog elsewhere. */
export default function ToolsModal({ p, open, onClose, accent, setAccent }: ToolsModalProps) {
  const dialog = useRef<HTMLDivElement>(null)
  useDialog(dialog, open)
  const [motion, setMotion] = useMotionPref()
  const reduced = useReducedMotion()
  if (!open) return null
  const mode = MODES.find((m) => m[0] === p.transition) || MODES[0]
  const accentLightened = accentTheme(accent)?.adjusted === true

  return (
    <div ref={dialog} data-modal="true" role="dialog" aria-modal="true" aria-label="Sound and tools" className="fixed inset-0 z-[55] flex items-end justify-center md:items-center">
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

        <EqSection p={p} />

        <DynamicsSection p={p} />

        <SpatialSection p={p} />

        <ReverbSection p={p} />

        <ShareSection />

        <BackupSection p={p} />

        <StorageSection p={p} />

        <HotkeysSection />

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
              aria-valuetext={`${p.speed.toFixed(2)} times normal speed`}
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
          <p className="mt-2 text-xs text-zinc-400">Off gives a vinyl-style pitch shift as speed changes.</p>
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
          {accentLightened && <p className="mt-2 text-xs text-zinc-400">That color is too dark to read on this theme, so it is shown slightly lighter.</p>}
        </section>

        <section aria-label="Motion" className="mt-6">
          <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-zinc-400">
            <Accessibility size={15} /> Motion
          </h3>
          <RovingGroup role="radiogroup" label="Animation" className="flex flex-wrap gap-2">
            {MOTION_OPTIONS.map(([id, label]) => (
              <button key={id} role="radio" aria-checked={motion === id} tabIndex={motion === id ? 0 : -1} onClick={() => setMotion(id)} className={chip(motion === id)}>
                {label}
              </button>
            ))}
          </RovingGroup>
          <p className="mt-2 text-xs text-zinc-400">
            {reduced ? 'Animations, fades and the live visualizer are switched off.' : 'Sheets slide, lyrics scroll smoothly and the visualizer moves.'}
            {motion === 'system' ? ' Follows your device setting.' : ''}
          </p>
        </section>

        <SeekBarSection />

        <LongFormSection />

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
          <RovingGroup role="radiogroup" label="Track transitions" className="flex flex-wrap gap-2">
            {MODES.map(([id, label]) => (
              <button key={id} role="radio" aria-checked={p.transition === id} tabIndex={p.transition === id ? 0 : -1} onClick={() => p.setTransition(id)} className={chip(p.transition === id)}>
                {label}
              </button>
            ))}
          </RovingGroup>
          <p className="mt-2 text-xs text-zinc-400">{mode?.[2]}</p>
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
          <p className="mt-2 text-xs text-zinc-400">
            Evens out loud and quiet tracks. Loudness is measured on your device the first time a track plays, then remembered
            {p.current?.gainDb != null && p.normalize ? ` (this track: ${p.current.gainDb > 0 ? '+' : ''}${p.current.gainDb} dB).` : '.'}
          </p>
        </section>
      </div>
    </div>
  )
}
