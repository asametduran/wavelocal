import { useMemo } from 'react'
import { Waves } from 'lucide-react'
import RangeRow from './RangeRow'
import RovingGroup from './RovingGroup'
import { DECAY_MAX, DECAY_MIN, PRE_DELAY_MAX_MS, ROOM_KINDS, ROOM_PROFILES, generateImpulseResponse, irEnvelope } from '../lib/reverb'
import type { PlayerApi, RoomKind } from '../types'

const chip = (on: boolean) =>
  `rounded-full px-3 py-1.5 text-sm font-semibold transition ${on ? 'bg-accent text-on-accent' : 'bg-white/10 text-zinc-200 hover:bg-white/15'}`

const PREVIEW_WIDTH = 240
const PREVIEW_HEIGHT = 44
const PREVIEW_BINS = 96
/** A coarse sample rate is plenty to draw the decay shape and keeps the preview essentially free. */
const PREVIEW_RATE = 2000

/** The loudness envelope of the room's impulse response: a quick visual for what Decay and Room do. */
function DecayPreview({ room, decay }: { room: RoomKind; decay: number }) {
  const points = useMemo(() => {
    const ir = generateImpulseResponse({ room, decay, sampleRate: PREVIEW_RATE })
    const env = irEnvelope(ir.left, PREVIEW_BINS)
    const line = Array.from(env, (v, i) => `${((i / (PREVIEW_BINS - 1)) * PREVIEW_WIDTH).toFixed(1)},${(PREVIEW_HEIGHT - 2 - v * (PREVIEW_HEIGHT - 6)).toFixed(1)}`)
    return `0,${PREVIEW_HEIGHT} ${line.join(' ')} ${PREVIEW_WIDTH},${PREVIEW_HEIGHT}`
  }, [room, decay])

  return (
    <svg
      viewBox={`0 0 ${PREVIEW_WIDTH} ${PREVIEW_HEIGHT}`}
      role="img"
      aria-label={`Decay preview: ${ROOM_PROFILES[room].label}, ${decay.toFixed(1)} seconds`}
      className="h-11 w-full rounded-lg bg-base/60"
      preserveAspectRatio="none"
    >
      <polygon points={points} className="fill-accent/30 stroke-accent" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

/** Room reverb: convolution with procedurally generated impulse responses, plus decay, pre-delay and wet/dry controls. */
export default function ReverbSection({ p }: { p: PlayerApi }) {
  const { reverb: r, setReverb } = p
  const profile = ROOM_PROFILES[r.room]

  return (
    <section aria-label="Reverb" className="mt-6">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-zinc-400">
          <Waves size={15} /> Reverb
        </h3>
        <button
          role="switch"
          aria-checked={r.enabled}
          onClick={() => setReverb({ enabled: !r.enabled })}
          className={`relative h-7 w-12 rounded-full transition ${r.enabled ? 'bg-accent' : 'bg-white/15'}`}
          aria-label="Enable reverb"
        >
          <span className={`absolute top-1 h-5 w-5 rounded-full bg-white transition-all ${r.enabled ? 'left-6' : 'left-1'}`} />
        </button>
      </div>

      <div className={`flex flex-col gap-3 transition-opacity ${r.enabled ? '' : 'opacity-50'}`}>
        <RovingGroup role="radiogroup" label="Room" className="flex flex-wrap gap-2">
          {ROOM_KINDS.map((room) => (
            <button key={room} role="radio" aria-checked={r.room === room} tabIndex={r.room === room ? 0 : -1} onClick={() => setReverb({ room })} className={chip(r.room === room)}>
              {ROOM_PROFILES[room].label}
            </button>
          ))}
        </RovingGroup>
        <p className="text-xs text-zinc-400">{profile.description}</p>

        <DecayPreview room={r.room} decay={r.decay} />

        <RangeRow
          label="Decay"
          ariaLabel="Reverb decay"
          value={r.decay}
          min={DECAY_MIN}
          max={DECAY_MAX}
          step={0.1}
          display={`${r.decay.toFixed(1)} s`}
          disabled={!r.enabled}
          onChange={(decay) => setReverb({ decay })}
        />
        <RangeRow
          label="Pre-delay"
          ariaLabel="Reverb pre-delay"
          value={r.preDelayMs}
          min={0}
          max={PRE_DELAY_MAX_MS}
          step={1}
          display={`${Math.round(r.preDelayMs)} ms`}
          disabled={!r.enabled}
          onChange={(preDelayMs) => setReverb({ preDelayMs })}
        />
        <RangeRow
          label="Wet / dry"
          ariaLabel="Reverb wet/dry mix"
          value={r.mix}
          min={0}
          max={1}
          step={0.01}
          display={`${Math.round(r.mix * 100)}% wet`}
          disabled={!r.enabled}
          onChange={(mix) => setReverb({ mix })}
        />
      </div>
    </section>
  )
}
