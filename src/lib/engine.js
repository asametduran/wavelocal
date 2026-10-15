/** Web Audio DSP engine: two playback decks -> 10-band EQ -> analyser -> master fade -> speakers. */

export const EQ_FREQS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]
export const EQ_LABELS = ['31', '62', '125', '250', '500', '1k', '2k', '4k', '8k', '16k']
export const EQ_MAX_DB = 12

export const EQ_PRESETS = {
  Flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  'Bass Boost': [7, 6, 5, 3, 1, 0, 0, 0, 0, 0],
  Vocal: [-3, -2, -1, 1, 3, 4, 4, 2, 0, -1],
  Rock: [5, 4, 2, -1, -2, -1, 2, 4, 5, 5],
  Acoustic: [4, 3, 2, 1, 1, 1, 2, 3, 3, 2],
  Electronic: [5, 4, 1, 0, -2, 2, 1, 2, 5, 5],
  'Treble Boost': [0, 0, 0, 0, 0, 1, 3, 5, 6, 7],
}

export class AudioEngine {
  constructor() {
    this.decks = [0, 1].map(() => {
      const el = new Audio()
      el.preload = 'auto'
      return { el, node: null, gain: null }
    })
    this.ctx = null
    this.analyser = null
    this.filters = []
    this.master = null
    this.eq = new Array(EQ_FREQS.length).fill(0)
    this.eqOn = true
    this.normLin = [1, 1] // linear normalization gain per deck, applied when the graph exists
  }

  /** Set a deck's loudness-normalization gain (linear). Safe to call before init(). */
  setNorm(deckIdx, lin) {
    this.normLin[deckIdx] = lin
    const g = this.decks[deckIdx].norm?.gain
    if (!g) return
    const t = this.ctx.currentTime
    g.cancelScheduledValues(t)
    g.setValueAtTime(lin, t)
  }

  /** Build the audio graph. Must be called from a user gesture the first time (autoplay policy). */
  init() {
    if (this.ctx) {
      if (this.ctx.state !== 'running') this.ctx.resume().catch(() => {})
      return true
    }
    const AC = window.AudioContext || window.webkitAudioContext
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
      filters.forEach((f, i) => i > 0 && filters[i - 1].connect(f))
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 1024
      analyser.smoothingTimeConstant = 0.8
      const master = ctx.createGain()
      filters[filters.length - 1].connect(analyser)
      analyser.connect(master)
      master.connect(ctx.destination)
      this.decks.forEach((d, i) => {
        d.node = ctx.createMediaElementSource(d.el)
        d.norm = ctx.createGain() // per-track loudness normalization
        d.norm.gain.value = this.normLin[i]
        d.gain = ctx.createGain() // crossfade
        d.node.connect(d.norm)
        d.norm.connect(d.gain)
        d.gain.connect(filters[0])
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

  applyEq(immediate = false) {
    if (!this.ctx) return
    const t = this.ctx.currentTime
    this.filters.forEach((f, i) => {
      const v = this.eqOn ? this.eq[i] : 0
      if (immediate) f.gain.setValueAtTime(v, t)
      else f.gain.setTargetAtTime(v, t, 0.02)
    })
  }

  setEq(gains) {
    this.eq = gains.slice()
    this.applyEq()
  }

  setEqEnabled(on) {
    this.eqOn = on
    this.applyEq()
  }

  setGain(deckIdx, value) {
    const g = this.decks[deckIdx].gain?.gain
    if (!g) return
    const t = this.ctx.currentTime
    g.cancelScheduledValues(t)
    g.setValueAtTime(value, t)
  }

  ramp(deckIdx, to, secs) {
    const g = this.decks[deckIdx].gain?.gain
    if (!g) return
    const t = this.ctx.currentTime
    g.cancelScheduledValues(t)
    g.setValueAtTime(g.value, t)
    g.linearRampToValueAtTime(to, t + secs)
  }

  fadeMaster(to, secs) {
    if (!this.master) return false
    const g = this.master.gain
    const t = this.ctx.currentTime
    g.cancelScheduledValues(t)
    g.setValueAtTime(g.value, t)
    g.linearRampToValueAtTime(to, t + Math.max(0.05, secs))
    return true
  }

  restoreMaster() {
    if (!this.master) return
    const g = this.master.gain
    const t = this.ctx.currentTime
    g.cancelScheduledValues(t)
    g.setValueAtTime(g.value, t)
    g.linearRampToValueAtTime(1, t + 0.2)
  }
}
