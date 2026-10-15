import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import EqCurve from './EqCurve'
import RangeRow from './RangeRow'
import { EQ_LABELS, EQ_MAX_DB, EQ_PRESETS } from '../lib/engine'
import {
  BAND_TYPES,
  FREQ_MIN,
  FREQ_MAX,
  GAIN_LIMIT,
  MAX_BANDS,
  MAX_PRESETS,
  Q_MAX,
  Q_MIN,
  bandTypeInfo,
  bandsEqual,
  describeBand,
  formatFrequency,
  formatGain,
  freqToPos,
  isGraphicLayout,
  posToFreq,
} from '../lib/eq'
import type { CSSProperties } from 'react'
import type { PlayerApi } from '../types'

type View = 'graphic' | 'parametric'
const VIEW_KEY = 'wl-eq-view'

const chip = (on: boolean) =>
  `rounded-full px-4 py-2 text-sm font-semibold transition ${on ? 'bg-accent text-black' : 'bg-white/10 text-zinc-200 hover:bg-white/15'}`

const loadView = (): View => {
  try {
    return localStorage.getItem(VIEW_KEY) === 'parametric' ? 'parametric' : 'graphic'
  } catch {
    return 'graphic'
  }
}

const same = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((v, i) => v === b[i])

/** Log-scaled quality-factor slider position (0..1) and back. */
const qToPos = (q: number) => Math.log(q / Q_MIN) / Math.log(Q_MAX / Q_MIN)
const posToQ = (pos: number) => Math.round(Q_MIN * (Q_MAX / Q_MIN) ** pos * 100) / 100

/** Equalizer: the classic 10-band graphic view and a parametric editor over the very same bands. */
export default function EqSection({ p }: { p: PlayerApi }) {
  const [view, setViewState] = useState<View>(loadView)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const bands = p.eqBands
  const graphic = isGraphicLayout(bands)
  const selected = bands.find((b) => b.id === selectedId) ?? null
  const selectedIndex = selected ? bands.indexOf(selected) : -1
  const info = selected ? bandTypeInfo(selected.type) : null

  const setView = (v: View) => {
    setViewState(v)
    try {
      localStorage.setItem(VIEW_KEY, v)
    } catch {
      /* ignore */
    }
  }

  // keep a valid selection: the first band when the current one disappears
  useEffect(() => {
    if (!bands.some((b) => b.id === selectedId)) setSelectedId(bands[0]?.id ?? null)
  }, [bands, selectedId])

  const activePreset = graphic ? Object.keys(EQ_PRESETS).find((k) => same(EQ_PRESETS[k] ?? [], p.eq)) : undefined
  const activeCustom = p.eqPresets.find((preset) => bandsEqual(preset.bands, bands))?.name

  const onSave = () => {
    const name = window.prompt('Name this equalizer preset')
    if (name && name.trim()) p.saveEqPreset(name)
  }

  const add = (patch?: { frequency?: number; gain?: number }) => {
    const id = p.addEqBand(patch)
    if (id) {
      setSelectedId(id)
      setView('parametric')
    }
  }

  return (
    <section aria-label="Equalizer">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-zinc-400">Equalizer</h3>
        <div className="flex items-center gap-3">
          <div role="tablist" aria-label="Equalizer view" className="flex gap-1 rounded-full bg-white/5 p-1">
            {(['graphic', 'parametric'] as const).map((v) => (
              <button
                key={v}
                role="tab"
                aria-selected={view === v}
                onClick={() => setView(v)}
                className={`rounded-full px-3 py-1 text-xs font-semibold capitalize transition ${view === v ? 'bg-white text-black' : 'text-zinc-300 hover:bg-white/10'}`}
              >
                {v}
              </button>
            ))}
          </div>
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
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        {Object.keys(EQ_PRESETS).map((name) => (
          <button key={name} onClick={() => p.applyPreset(name)} className={chip(activePreset === name)} aria-pressed={activePreset === name}>
            {name}
          </button>
        ))}
        {p.eqPresets.map((preset) => (
          <span key={preset.name} className="flex items-center" role="group" aria-label={`Custom preset ${preset.name}`}>
            <button
              onClick={() => p.loadEqPreset(preset.name)}
              className={`${chip(activeCustom === preset.name)} rounded-r-none border-r border-black/20`}
              aria-pressed={activeCustom === preset.name}
              title={`Load "${preset.name}"`}
            >
              {preset.name}
            </button>
            <button
              onClick={() => p.deleteEqPreset(preset.name)}
              className={`${chip(false)} rounded-l-none px-2.5 text-zinc-400 hover:text-red-400`}
              aria-label={`Delete preset ${preset.name}`}
            >
              <X size={14} />
            </button>
          </span>
        ))}
        <button onClick={onSave} disabled={p.eqPresets.length >= MAX_PRESETS} className={`${chip(false)} disabled:opacity-40`}>
          Save preset…
        </button>
        <button onClick={p.resetEq} className={chip(false)}>
          Reset
        </button>
      </div>

      {p.current && (
        <div className="mb-3 flex items-center justify-between gap-3 rounded-xl bg-white/5 px-3 py-2">
          <div className="min-w-0">
            <div className="text-sm text-zinc-200">Remember EQ for this track</div>
            <div className="truncate text-xs text-zinc-500">
              {p.eqRemembered ? `Using its own curve for "${p.current.title}" - other tracks keep the shared EQ.` : `Edits apply to every track without its own EQ. Turn on to give "${p.current.title}" its own curve.`}
            </div>
          </div>
          <button
            role="switch"
            aria-checked={p.eqRemembered}
            onClick={() => p.setEqRemembered(!p.eqRemembered)}
            className={`relative h-7 w-12 shrink-0 rounded-full transition ${p.eqRemembered ? 'bg-accent' : 'bg-white/15'}`}
            aria-label="Remember EQ for this track"
          >
            <span className={`absolute top-1 h-5 w-5 rounded-full bg-white transition-all ${p.eqRemembered ? 'left-6' : 'left-1'}`} />
          </button>
        </div>
      )}

      {view === 'graphic' ? (
        graphic ? (
          <>
            <div className={`flex justify-between gap-1 rounded-2xl bg-base/60 px-2 py-4 transition-opacity ${p.eqOn ? '' : 'opacity-40'}`}>
              {EQ_LABELS.map((label, i) => {
                const gain = p.eq[i] ?? 0
                return (
                  <div key={label} className="flex flex-col items-center gap-2">
                    <span className="w-9 text-center text-[11px] tabular-nums text-zinc-400">
                      {gain > 0 ? '+' : ''}
                      {gain}
                    </span>
                    <div className="relative h-36 w-9">
                      <input
                        type="range"
                        min={-EQ_MAX_DB}
                        max={EQ_MAX_DB}
                        step={0.5}
                        value={gain}
                        onChange={(e) => p.setEqBand(i, parseFloat(e.target.value))}
                        onDoubleClick={() => p.setEqBand(i, 0)}
                        aria-label={`${label} Hz gain`}
                        className="slider always absolute left-1/2 top-1/2 w-36 -translate-x-1/2 -translate-y-1/2 -rotate-90"
                        style={{ '--p': `${((gain + EQ_MAX_DB) / (EQ_MAX_DB * 2)) * 100}%` } as CSSProperties}
                      />
                    </div>
                    <span className="text-[11px] text-zinc-500">{label}</span>
                  </div>
                )
              })}
            </div>
            <p className="mt-2 text-xs text-zinc-500">Double-click a band to reset it. Values are in dB. Switch to Parametric to shape frequency, width and filter type.</p>
          </>
        ) : (
          <div className="rounded-2xl bg-base/60 p-4 text-sm text-zinc-300">
            <p>
              This equalizer uses {bands.length} custom {bands.length === 1 ? 'band' : 'bands'}, which the ten fixed sliders cannot show. Edit them in the Parametric view, or
              return to the standard layout.
            </p>
            <button onClick={() => p.applyPreset('Flat')} className={`${chip(false)} mt-3`}>
              Reset to 10-band layout
            </button>
          </div>
        )
      ) : (
        <div className="flex flex-col gap-3">
          <EqCurve
            bands={bands}
            enabled={p.eqOn}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onChange={p.updateEqBand}
            onRemove={p.removeEqBand}
            onAddAt={(frequency, gain) => add({ frequency, gain })}
          />

          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Bands">
            {bands.map((b, i) => (
              <button
                key={b.id}
                onClick={() => setSelectedId(b.id)}
                aria-pressed={b.id === selectedId}
                title={describeBand(b)}
                className={`rounded-full px-3 py-1 text-xs font-semibold tabular-nums transition ${b.id === selectedId ? 'bg-accent text-black' : 'bg-white/10 text-zinc-200 hover:bg-white/15'}`}
              >
                {i + 1} · {formatFrequency(b.frequency)}
              </button>
            ))}
            <button onClick={() => add()} disabled={bands.length >= MAX_BANDS} className="rounded-full bg-white/10 px-3 py-1 text-xs font-semibold hover:bg-white/15 disabled:opacity-40">
              + Add band
            </button>
          </div>

          {selected && info ? (
            <div className="flex flex-col gap-3 rounded-2xl bg-base/60 p-3" role="group" aria-label={`Band ${selectedIndex + 1} settings`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Band type">
                  {BAND_TYPES.map((t) => (
                    <button
                      key={t.type}
                      role="radio"
                      aria-checked={selected.type === t.type}
                      onClick={() => p.updateEqBand(selected.id, { type: t.type })}
                      className={`rounded-full px-3 py-1 text-xs font-semibold transition ${selected.type === t.type ? 'bg-accent text-black' : 'bg-white/10 text-zinc-200 hover:bg-white/15'}`}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
                <button onClick={() => p.removeEqBand(selected.id)} className="rounded-full bg-white/10 px-3 py-1 text-xs font-semibold text-zinc-300 hover:text-red-400">
                  Remove band
                </button>
              </div>
              <RangeRow
                label="Frequency"
                ariaLabel="Band frequency"
                value={freqToPos(selected.frequency)}
                min={0}
                max={1}
                step={0.001}
                display={formatFrequency(selected.frequency)}
                onChange={(pos) => p.updateEqBand(selected.id, { frequency: Math.round(posToFreq(pos)) })}
              />
              {info.usesGain && (
                <RangeRow
                  label="Gain"
                  ariaLabel="Band gain"
                  value={selected.gain}
                  min={-GAIN_LIMIT}
                  max={GAIN_LIMIT}
                  step={0.1}
                  display={formatGain(selected.gain)}
                  onChange={(gain) => p.updateEqBand(selected.id, { gain })}
                />
              )}
              {info.usesQ && (
                <RangeRow
                  label="Q (width)"
                  ariaLabel="Band Q"
                  value={qToPos(selected.q)}
                  min={0}
                  max={1}
                  step={0.005}
                  display={selected.q.toFixed(2)}
                  onChange={(pos) => p.updateEqBand(selected.id, { q: posToQ(pos) })}
                />
              )}
            </div>
          ) : (
            <p className="text-sm text-zinc-500">No bands - this equalizer is flat. Add a band, or double-click the curve.</p>
          )}
          <p className="text-xs text-zinc-500">
            Drag a handle to set frequency and gain, scroll over it to change the width (Q), double-click empty space to add a band. With a handle focused: arrow keys move
            it, + / - change Q, Delete removes it. Range {formatFrequency(FREQ_MIN)} - {formatFrequency(FREQ_MAX)}, up to {MAX_BANDS} bands.
          </p>
        </div>
      )}
    </section>
  )
}
