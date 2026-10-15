/** Web Audio DSP engine: two playback decks -> 10-band EQ -> analyser -> master fade -> speakers. */
import type { EqGains } from '../types'

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
      last.connect(analyser)
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
      this.ctx = ctx
      this.filters = filters
      this.analyser = analyser
      this.master = master
      this.applyEq(true)
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
