/** Web Audio DSP engine: two playback decks -> 10-band EQ -> analyser -> master fade -> speakers. */
import type { EqGains, ReverbSettings, SpatialSettings } from '../types'
import { DEFAULT_SPATIAL, ORBIT_HORIZON_SECONDS, azimuth, equalPowerMix, orbitAngle, orbitCurve, orbitPosition, orbitRadiusMeters, orbitRadiusPad, padToPosition } from './spatial'
import type { Point2 } from './spatial'
import { DEFAULT_REVERB, generateImpulseResponse, impulseKey } from './reverb'

export const EQ_FREQS: readonly number[] = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]
export const EQ_LABELS: readonly string[] = ['31', '62', '125', '250', '500', '1k', '2k', '4k', '8k', '16k']
export const EQ_MAX_DB = 12

export const EQ_PRESETS: Record<string, EqGains> = {
  Flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  'Bass Boost': [7, 6, 5, 3, 1, 0, 0, 0, 0, 0],
  Vocal: [-3, -2, -1, 1, 3, 4, 4, 2, 0, -1],
  Rock: [5, 4, 2, -1, -2, -1, 2, 4, 5, 5],
  Acoustic: [4, 3, 2, 1, 1, 1, 2, 3, 3, 2],
  Electronic: [5, 4, 1, 0, -2, 2, 1, 2, 5, 5],
  'Treble Boost': [0, 0, 0, 0, 0, 1, 3, 5, 6, 7],
}

/** One playback deck: its media element and the nodes created for it once the graph exists. */
export interface Deck {
  el: HTMLAudioElement
  node: MediaElementAudioSourceNode | null
  /** Per-track loudness normalization gain. */
  norm: GainNode | null
  /** Crossfade gain. */
  gain: GainNode | null
}

type WebkitWindow = Window & { webkitAudioContext?: typeof AudioContext }

/** Spatial stage: EQ output -> dry -> out, and EQ output -> HRTF panner -> wet -> out (panner only routed while enabled). */
interface SpatialNodes {
  input: AudioNode
  panner: PannerNode
  dry: GainNode
  wet: GainNode
  out: GainNode
  routed: boolean
}

/** Reverb stage: input -> dry -> out, and input -> pre-delay -> convolver -> wet -> out (convolver only fed while enabled). */
interface ReverbNodes {
  input: AudioNode
  preDelay: DelayNode
  convolver: ConvolverNode
  dry: GainNode
  wet: GainNode
  out: GainNode
  routed: boolean
}

/** Anchor of the current orbit: the angle at audio time `t0`, so any later position is a pure function of the clock. */
interface Orbit {
  active: boolean
  angle0: number
  t0: number
  seconds: number
  radiusPad: number
  /** Settings that shaped the scheduled curve; an unchanged key means no reschedule is needed. */
  key: string
  timer: ReturnType<typeof setInterval> | null
}

const ORBIT_REFRESH_MS = 60_000
const SPATIAL_OFF_DELAY_MS = 180
const REVERB_OFF_DELAY_MS = 250
/** Wait for slider drags to settle before synthesizing a new impulse response. */
const REVERB_REBUILD_DEBOUNCE_MS = 120
/** Time the wet signal is muted around an impulse swap so it cannot click. */
const REVERB_DUCK_MS = 50
const REVERB_CACHE_SIZE = 6
const MAX_PRE_DELAY_S = 0.25

/** Cancel pending automation at `t` but keep the value the parameter has reached (works mid-curve). */
function holdAt(param: AudioParam, t: number): void {
  if (typeof param.cancelAndHoldAtTime === 'function') {
    param.cancelAndHoldAtTime(t)
  } else {
    const v = param.value
    param.cancelScheduledValues(t)
    param.setValueAtTime(v, t)
  }
}

function glideTo(param: AudioParam, target: number, t: number, timeConstant = 0.04): void {
  holdAt(param, t)
  param.setTargetAtTime(target, t, timeConstant)
}

export class AudioEngine {
  decks: [Deck, Deck]
  ctx: AudioContext | null = null
  analyser: AnalyserNode | null = null
  filters: BiquadFilterNode[] = []
  master: GainNode | null = null
  eq: EqGains = new Array<number>(EQ_FREQS.length).fill(0)
  eqOn = true
  /** Linear normalization gain per deck, applied when the graph exists. */
  normLin: [number, number] = [1, 1]
  /** Latest spatial settings; applied to the graph as soon as (and whenever) it exists. */
  spatial: SpatialSettings = { ...DEFAULT_SPATIAL }
  /** False when the browser lacks AudioParam-based panner positions (old Safari); spatial then passes audio through. */
  spatialSupported = true
  private spatialNodes: SpatialNodes | null = null
  private spatialOffTimer: ReturnType<typeof setTimeout> | null = null
  private orbit: Orbit = { active: false, angle0: 0, t0: 0, seconds: DEFAULT_SPATIAL.orbitSeconds, radiusPad: 1, key: '', timer: null }
  /** Latest reverb settings; applied to the graph as soon as (and whenever) it exists. */
  reverb: ReverbSettings = { ...DEFAULT_REVERB }
  private reverbNodes: ReverbNodes | null = null
  private reverbKey: string | null = null
  private reverbTimer: ReturnType<typeof setTimeout> | null = null
  private reverbOffTimer: ReturnType<typeof setTimeout> | null = null
  private reverbDucking = false
  private reverbCache = new Map<string, AudioBuffer>()

  constructor() {
    const makeDeck = (): Deck => {
      const el = new Audio()
      el.preload = 'auto'
      return { el, node: null, norm: null, gain: null }
    }
    this.decks = [makeDeck(), makeDeck()]
  }

  /** Set a deck's loudness-normalization gain (linear). Safe to call before init(). */
  setNorm(deckIdx: 0 | 1, lin: number): void {
    this.normLin[deckIdx] = lin
    const g = this.decks[deckIdx].norm?.gain
    if (!g || !this.ctx) return
    const t = this.ctx.currentTime
    g.cancelScheduledValues(t)
    g.setValueAtTime(lin, t)
  }

  /** Build the audio graph. Must be called from a user gesture the first time (autoplay policy). */
  init(): boolean {
    if (this.ctx) {
      if (this.ctx.state !== 'running') this.ctx.resume().catch(() => {})
      return true
    }
    const AC = window.AudioContext || (window as WebkitWindow).webkitAudioContext
    if (!AC) return false
    try {
      const ctx = new AC()
      const filters = EQ_FREQS.map((f, i) => {
        const b = ctx.createBiquadFilter()
        b.type = i === 0 ? 'lowshelf' : i === EQ_FREQS.length - 1 ? 'highshelf' : 'peaking'
        b.frequency.value = f
        b.Q.value = 1.1
        return b
      })
      filters.forEach((f, i) => {
        const prev = filters[i - 1]
        if (prev) prev.connect(f)
      })
      const first = filters[0]
      const last = filters[filters.length - 1]
      if (!first || !last) throw new Error('EQ chain is empty')
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 1024
      analyser.smoothingTimeConstant = 0.8
      const master = ctx.createGain()
      analyser.connect(master)
      master.connect(ctx.destination)
      this.decks.forEach((d, i) => {
        const node = ctx.createMediaElementSource(d.el)
        const norm = ctx.createGain() // per-track loudness normalization
        norm.gain.value = this.normLin[i] ?? 1
        const gain = ctx.createGain() // crossfade
        node.connect(norm)
        norm.connect(gain)
        gain.connect(first)
        d.node = node
        d.norm = norm
        d.gain = gain
      })
      const tail = this.buildSpatial(ctx, last)
      this.buildReverb(ctx, tail, analyser)
      this.ctx = ctx
      this.filters = filters
      this.analyser = analyser
      this.master = master
      this.applyEq(true)
      this.applySpatial()
      this.applyReverb()
      if (ctx.state !== 'running') ctx.resume().catch(() => {})
      return true
    } catch {
      this.ctx = null
      return false
    }
  }

  applyEq(immediate = false): void {
    if (!this.ctx) return
    const t = this.ctx.currentTime
    this.filters.forEach((f, i) => {
      const v = this.eqOn ? (this.eq[i] ?? 0) : 0
      if (immediate) f.gain.setValueAtTime(v, t)
      else f.gain.setTargetAtTime(v, t, 0.02)
    })
  }

  setEq(gains: EqGains): void {
    this.eq = gains.slice()
    this.applyEq()
  }

  setEqEnabled(on: boolean): void {
    this.eqOn = on
    this.applyEq()
  }

  // ---- 3D spatial audio ----

  /** Create the dry/wet/panner stage after the EQ and return the node carrying its output (the input itself if unsupported). */
  private buildSpatial(ctx: AudioContext, input: AudioNode): AudioNode {
    const panner = ctx.createPanner()
    if (!('positionX' in panner)) {
      this.spatialSupported = false
      return input
    }
    panner.panningModel = 'HRTF'
    panner.distanceModel = 'inverse'
    panner.refDistance = 1
    panner.rolloffFactor = 0.3 // gentler than physical so far sources stay audible
    const dry = ctx.createGain()
    const wet = ctx.createGain()
    const out = ctx.createGain()
    input.connect(dry)
    dry.connect(out)
    panner.connect(wet)
    wet.connect(out)
    dry.gain.value = 1
    wet.gain.value = 0
    this.spatialSupported = true
    this.spatialNodes = { input, panner, dry, wet, out, routed: false }
    return out
  }

  /** Store new settings and apply them to the graph (if it exists yet). */
  setSpatial(next: SpatialSettings): void {
    this.spatial = next
    this.applySpatial()
  }

  private applySpatial(): void {
    const n = this.spatialNodes
    const ctx = this.ctx
    if (!n || !ctx) return
    const s = this.spatial
    const t = ctx.currentTime
    const { dry, wet } = s.enabled ? equalPowerMix(s.mix) : { dry: 1, wet: 0 }
    glideTo(n.dry.gain, dry, t, 0.03)
    glideTo(n.wet.gain, wet, t, 0.03)

    if (!s.enabled) {
      // let the wet path fade out, then stop feeding (and burning CPU in) the HRTF panner
      if (this.spatialOffTimer === null && n.routed) {
        this.spatialOffTimer = setTimeout(() => {
          this.spatialOffTimer = null
          const nodes = this.spatialNodes
          if (this.spatial.enabled || !nodes?.routed) return
          nodes.input.disconnect(nodes.panner)
          nodes.routed = false
          this.stopOrbit()
        }, SPATIAL_OFF_DELAY_MS)
      }
      return
    }

    if (this.spatialOffTimer !== null) {
      clearTimeout(this.spatialOffTimer)
      this.spatialOffTimer = null
    }
    const fresh = !n.routed
    if (s.rotate) {
      this.scheduleOrbit(fresh)
    } else {
      this.stopOrbit()
      const p = padToPosition(s)
      const { positionX, positionY, positionZ } = n.panner
      for (const [param, value] of [[positionX, p.x], [positionY, p.y], [positionZ, p.z]] as const) {
        if (fresh) {
          holdAt(param, t)
          param.setValueAtTime(value, t)
        } else {
          glideTo(param, value, t, 0.05)
        }
      }
    }
    if (fresh) {
      n.input.connect(n.panner)
      n.routed = true
    }
  }

  /**
   * Put the source on a circular path using automation curves rather than an LFO, so the position stays
   * readable, survives timer throttling, and re-anchors smoothly whenever speed, radius or direction change.
   */
  private scheduleOrbit(fresh: boolean): void {
    const n = this.spatialNodes
    const ctx = this.ctx
    if (!n || !ctx) return
    const s = this.spatial
    const key = `${s.orbitSeconds}|${s.distance}|${s.x}|${s.y}`
    const o = this.orbit
    if (o.active && !fresh && o.key === key) return

    const now = ctx.currentTime
    const startAngle = o.active && !fresh ? orbitAngle(now - o.t0, o.seconds, o.angle0) : azimuth(s.x, s.y)
    const lead = 0.03
    const angleAtStart = orbitAngle(lead, s.orbitSeconds, startAngle)
    const radius = orbitRadiusMeters(s)
    const curve = orbitCurve({ startAngle: angleAtStart, orbitSeconds: s.orbitSeconds, radius, duration: ORBIT_HORIZON_SECONDS })
    const first = orbitPosition(angleAtStart, radius)

    const { positionX, positionY, positionZ } = n.panner
    holdAt(positionX, now)
    holdAt(positionZ, now)
    // jump straight to the orbit for a fresh start, otherwise glide the (tiny) re-anchoring difference
    positionX.setValueAtTime(fresh ? first.x : positionX.value, now)
    positionZ.setValueAtTime(fresh ? first.z : positionZ.value, now)
    positionX.setValueCurveAtTime(curve.x, now + lead, ORBIT_HORIZON_SECONDS)
    positionZ.setValueCurveAtTime(curve.z, now + lead, ORBIT_HORIZON_SECONDS)
    glideTo(positionY, 0, now)

    o.active = true
    o.angle0 = angleAtStart
    o.t0 = now + lead
    o.seconds = s.orbitSeconds
    o.radiusPad = orbitRadiusPad(s.x, s.y)
    o.key = key
    if (o.timer === null) o.timer = setInterval(() => this.refreshOrbit(), ORBIT_REFRESH_MS)
  }

  /** Extend the scheduled curve before it runs out (re-anchors at the current angle, so there is no jump). */
  private refreshOrbit(): void {
    if (!this.orbit.active || !this.spatial.enabled || !this.spatial.rotate) return
    this.orbit.key = '' // force a reschedule
    this.scheduleOrbit(false)
  }

  private stopOrbit(): void {
    const o = this.orbit
    if (o.timer !== null) clearInterval(o.timer)
    o.timer = null
    if (!o.active) return
    o.active = false
    o.key = ''
    const n = this.spatialNodes
    const ctx = this.ctx
    if (!n || !ctx) return
    const t = ctx.currentTime
    holdAt(n.panner.positionX, t)
    holdAt(n.panner.positionZ, t)
  }

  /** Where the source is right now, in pad coordinates (for the live dot while rotating). */
  spatialPosition(): Point2 {
    const s = this.spatial
    const o = this.orbit
    if (o.active && this.ctx && s.enabled && s.rotate) {
      const a = orbitAngle(this.ctx.currentTime - o.t0, o.seconds, o.angle0)
      return { x: o.radiusPad * Math.sin(a), y: -o.radiusPad * Math.cos(a) }
    }
    return { x: s.x, y: s.y }
  }

  // ---- reverb ----

  /** Create the pre-delay / convolver / dry-wet stage between the spatial stage and the analyser. */
  private buildReverb(ctx: AudioContext, input: AudioNode, analyser: AnalyserNode): void {
    const preDelay = ctx.createDelay(MAX_PRE_DELAY_S)
    const convolver = ctx.createConvolver()
    convolver.normalize = true // keeps loudness comparable across rooms and decay times (must be set before the buffer)
    const dry = ctx.createGain()
    const wet = ctx.createGain()
    const out = ctx.createGain()
    input.connect(dry)
    dry.connect(out)
    preDelay.connect(convolver)
    convolver.connect(wet)
    wet.connect(out)
    out.connect(analyser)
    dry.gain.value = 1
    wet.gain.value = 0
    this.reverbNodes = { input, preDelay, convolver, dry, wet, out, routed: false }
  }

  /** Store new settings and apply them to the graph (if it exists yet). */
  setReverb(next: ReverbSettings): void {
    this.reverb = next
    this.applyReverb()
  }

  private applyReverb(): void {
    const n = this.reverbNodes
    const ctx = this.ctx
    if (!n || !ctx) return
    const r = this.reverb
    glideTo(n.preDelay.delayTime, Math.min(MAX_PRE_DELAY_S, r.preDelayMs / 1000), ctx.currentTime, 0.03)

    if (!r.enabled) {
      this.reverbDucking = false
      this.applyReverbGains()
      if (this.reverbTimer !== null) clearTimeout(this.reverbTimer)
      this.reverbTimer = null
      // once the wet path has faded, stop feeding (and burning CPU in) the convolver
      if (this.reverbOffTimer === null && n.routed) {
        this.reverbOffTimer = setTimeout(() => {
          this.reverbOffTimer = null
          const nodes = this.reverbNodes
          if (this.reverb.enabled || !nodes?.routed) return
          nodes.input.disconnect(nodes.preDelay)
          nodes.routed = false
        }, REVERB_OFF_DELAY_MS)
      }
      return
    }

    if (this.reverbOffTimer !== null) {
      clearTimeout(this.reverbOffTimer)
      this.reverbOffTimer = null
    }
    if (!n.routed) {
      n.input.connect(n.preDelay)
      n.routed = true
    }
    this.applyReverbGains()
    if (impulseKey(r, ctx.sampleRate) !== this.reverbKey) this.requestImpulse(n.convolver.buffer === null)
  }

  private applyReverbGains(): void {
    const n = this.reverbNodes
    const ctx = this.ctx
    if (!n || !ctx) return
    const r = this.reverb
    const { dry, wet } = r.enabled ? equalPowerMix(r.mix) : { dry: 1, wet: 0 }
    const t = ctx.currentTime
    glideTo(n.dry.gain, dry, t, 0.03)
    glideTo(n.wet.gain, this.reverbDucking ? 0 : wet, t, this.reverbDucking ? 0.008 : 0.03)
  }

  /** Synthesizing an impulse response takes a few milliseconds, so wait out slider drags (but not the very first build). */
  private requestImpulse(immediate: boolean): void {
    if (this.reverbTimer !== null) clearTimeout(this.reverbTimer)
    this.reverbTimer = setTimeout(() => this.swapImpulse(), immediate ? 0 : REVERB_REBUILD_DEBOUNCE_MS)
  }

  private swapImpulse(): void {
    this.reverbTimer = null
    const n = this.reverbNodes
    const ctx = this.ctx
    if (!n || !ctx || !this.reverb.enabled) return

    const commit = () => {
      this.reverbTimer = null
      this.reverbDucking = false
      if (!this.reverb.enabled) return
      const wanted = this.reverb
      n.convolver.buffer = this.impulseBuffer(wanted, ctx)
      this.reverbKey = impulseKey(wanted, ctx.sampleRate)
      this.applyReverbGains()
    }
    if (n.convolver.buffer === null) {
      commit()
      return
    }
    // mute the wet path, swap while it is silent, then bring it back
    this.reverbDucking = true
    this.applyReverbGains()
    this.reverbTimer = setTimeout(commit, REVERB_DUCK_MS)
  }

  private impulseBuffer(settings: ReverbSettings, ctx: AudioContext): AudioBuffer {
    const key = impulseKey(settings, ctx.sampleRate)
    const cached = this.reverbCache.get(key)
    if (cached) {
      this.reverbCache.delete(key) // refresh recency
      this.reverbCache.set(key, cached)
      return cached
    }
    const ir = generateImpulseResponse({ room: settings.room, decay: settings.decay, sampleRate: ctx.sampleRate })
    const buffer = ctx.createBuffer(2, ir.left.length, ctx.sampleRate)
    buffer.copyToChannel(ir.left, 0)
    buffer.copyToChannel(ir.right, 1)
    this.reverbCache.set(key, buffer)
    const oldest = this.reverbCache.keys().next().value
    if (this.reverbCache.size > REVERB_CACHE_SIZE && oldest !== undefined) this.reverbCache.delete(oldest)
    return buffer
  }

  setGain(deckIdx: 0 | 1, value: number): void {
    const g = this.decks[deckIdx].gain?.gain
    if (!g || !this.ctx) return
    const t = this.ctx.currentTime
    g.cancelScheduledValues(t)
    g.setValueAtTime(value, t)
  }

  ramp(deckIdx: 0 | 1, to: number, secs: number): void {
    const g = this.decks[deckIdx].gain?.gain
    if (!g || !this.ctx) return
    const t = this.ctx.currentTime
    g.cancelScheduledValues(t)
    g.setValueAtTime(g.value, t)
    g.linearRampToValueAtTime(to, t + secs)
  }

  fadeMaster(to: number, secs: number): boolean {
    if (!this.master || !this.ctx) return false
    const g = this.master.gain
    const t = this.ctx.currentTime
    g.cancelScheduledValues(t)
    g.setValueAtTime(g.value, t)
    g.linearRampToValueAtTime(to, t + Math.max(0.05, secs))
    return true
  }

  restoreMaster(): void {
    if (!this.master || !this.ctx) return
    const g = this.master.gain
    const t = this.ctx.currentTime
    g.cancelScheduledValues(t)
    g.setValueAtTime(g.value, t)
    g.linearRampToValueAtTime(1, t + 0.2)
  }
}
