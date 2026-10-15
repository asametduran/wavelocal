import { useCallback } from 'react'
import { Orbit } from 'lucide-react'
import RangeRow from './RangeRow'
import SpatialPad from './SpatialPad'
import { ORBIT_MAX_SECONDS, ORBIT_MIN_SECONDS, PAD_PRESETS, radiusMeters } from '../lib/spatial'
import type { PlayerApi } from '../types'

const chip = (on: boolean) =>
  `rounded-full px-3 py-1.5 text-sm font-semibold transition ${on ? 'bg-accent text-black' : 'bg-white/10 text-zinc-200 hover:bg-white/15'}`

/** 3D spatial audio controls: position pad, distance, wet/dry mix and the "8D" auto-rotate mode. */
export default function SpatialSection({ p }: { p: PlayerApi }) {
  const { spatial: s, setSpatial } = p
  const orbiting = s.enabled && s.rotate
  const supported = p.engine.spatialSupported
  const livePosition = useCallback(() => p.engine.spatialPosition(), [p.engine])
  const dim = s.enabled ? '' : 'opacity-50'

  return (
    <section aria-label="Spatial audio" className="mt-6">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-zinc-400">
          <Orbit size={15} /> 3D spatial audio
        </h3>
        <button
          role="switch"
          aria-checked={s.enabled}
          disabled={!supported}
          onClick={() => setSpatial({ enabled: !s.enabled })}
          className={`relative h-7 w-12 rounded-full transition disabled:opacity-40 ${s.enabled ? 'bg-accent' : 'bg-white/15'}`}
          aria-label="Enable 3D spatial audio"
        >
          <span className={`absolute top-1 h-5 w-5 rounded-full bg-white transition-all ${s.enabled ? 'left-6' : 'left-1'}`} />
        </button>
      </div>

      {!supported ? (
        <p className="text-xs text-zinc-500">This browser cannot position sounds in 3D, so the effect is unavailable.</p>
      ) : (
        <div className={`flex flex-col gap-4 transition-opacity sm:flex-row sm:items-start ${dim}`}>
          <div className="flex flex-col items-center gap-2 self-center">
            <SpatialPad
              x={s.x}
              y={s.y}
              disabled={!s.enabled}
              livePosition={orbiting ? livePosition : null}
              onChange={(x, y) => setSpatial({ x, y })}
            />
            <div className="flex flex-wrap justify-center gap-1.5" role="group" aria-label="Quick positions">
              {PAD_PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  disabled={!s.enabled}
                  onClick={() => setSpatial({ x: preset.x, y: preset.y })}
                  aria-pressed={Math.abs(s.x - preset.x) < 0.01 && Math.abs(s.y - preset.y) < 0.01}
                  className={`${chip(Math.abs(s.x - preset.x) < 0.01 && Math.abs(s.y - preset.y) < 0.01)} disabled:opacity-60`}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex min-w-0 flex-1 flex-col gap-3">
            <RangeRow
              label="Distance"
              value={s.distance}
              min={0}
              max={1}
              step={0.01}
              display={`${radiusMeters(s.distance).toFixed(1)} m`}
              disabled={!s.enabled}
              onChange={(distance) => setSpatial({ distance })}
            />
            <RangeRow
              label="Wet / dry mix"
              value={s.mix}
              min={0}
              max={1}
              step={0.01}
              display={`${Math.round(s.mix * 100)}% wet`}
              disabled={!s.enabled}
              onChange={(mix) => setSpatial({ mix })}
            />
            <label className="mt-1 flex items-center justify-between text-sm text-zinc-300">
              Auto-rotate (8D)
              <button
                role="switch"
                aria-checked={s.rotate}
                disabled={!s.enabled}
                onClick={() => setSpatial({ rotate: !s.rotate })}
                className={`relative h-7 w-12 rounded-full transition disabled:opacity-60 ${s.rotate ? 'bg-accent' : 'bg-white/15'}`}
                aria-label="Auto-rotate (8D)"
              >
                <span className={`absolute top-1 h-5 w-5 rounded-full bg-white transition-all ${s.rotate ? 'left-6' : 'left-1'}`} />
              </button>
            </label>
            <RangeRow
              label="Orbit time"
              value={s.orbitSeconds}
              min={ORBIT_MIN_SECONDS}
              max={ORBIT_MAX_SECONDS}
              step={0.5}
              display={`${s.orbitSeconds.toFixed(1)} s`}
              disabled={!s.enabled || !s.rotate}
              onChange={(orbitSeconds) => setSpatial({ orbitSeconds })}
            />
            <p className="text-xs text-zinc-500">
              Best with headphones. Drag the dot (or use the arrow keys) to place the sound around you; turn on Auto-rotate to circle it
              around your head.
            </p>
          </div>
        </div>
      )}
    </section>
  )
}
