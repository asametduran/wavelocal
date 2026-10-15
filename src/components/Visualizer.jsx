import { useEffect, useRef, useState } from 'react'

/** Canvas audio visualizer fed by the engine's AnalyserNode. Click to switch bars / waveform. */
export default function Visualizer({ engine, playing, className = '' }) {
  const ref = useRef(null)
  const [mode, setMode] = useState('bars')

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return undefined
    const g = canvas.getContext('2d')
    let raf = 0
    let w = 0
    let h = 0
    const BARS = 44
    const levels = new Float32Array(BARS)
    const bins = new Uint8Array(512)
    const wave = new Uint8Array(1024)

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      w = canvas.clientWidth
      h = canvas.clientHeight
      canvas.width = Math.max(1, Math.floor(w * dpr))
      canvas.height = Math.max(1, Math.floor(h * dpr))
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    const ro = new ResizeObserver(resize)
    ro.observe(canvas)
    resize()

    const draw = () => {
      g.clearRect(0, 0, w, h)
      const an = playing ? engine.analyser : null
      const grad = g.createLinearGradient(0, h, 0, 0)
      grad.addColorStop(0, getComputedStyle(document.documentElement).getPropertyValue('--accent-hex').trim() || '#a78bfa')
      grad.addColorStop(1, '#ec4899')
      let alive = false

      if (mode === 'bars') {
        if (an) an.getByteFrequencyData(bins)
        const usable = 380
        const gap = 3
        const bw = Math.max(2, (w - gap * (BARS - 1)) / BARS)
        g.fillStyle = grad
        for (let i = 0; i < BARS; i++) {
          let v = 0
          if (an) {
            const lo = Math.floor(Math.pow(i / BARS, 1.7) * usable) + 1
            const hi = Math.max(lo + 1, Math.floor(Math.pow((i + 1) / BARS, 1.7) * usable) + 1)
            let sum = 0
            for (let k = lo; k < hi; k++) sum += bins[k]
            v = sum / (hi - lo) / 255
          }
          levels[i] = Math.max(v, levels[i] * 0.86)
          if (levels[i] > 0.01) alive = true
          const bh = Math.max(2, levels[i] * h)
          const x = i * (bw + gap)
          g.beginPath()
          g.roundRect ? g.roundRect(x, h - bh, bw, bh, Math.min(bw / 2, 3)) : g.rect(x, h - bh, bw, bh)
          g.fill()
        }
      } else {
        if (an) {
          an.getByteTimeDomainData(wave)
          alive = true
        }
        g.lineWidth = 2.5
        g.lineCap = 'round'
        g.lineJoin = 'round'
        g.strokeStyle = grad
        g.beginPath()
        const n = 256
        for (let i = 0; i < n; i++) {
          const x = (i / (n - 1)) * w
          const v = an ? (wave[Math.floor((i / n) * wave.length)] - 128) / 128 : 0
          const y = h / 2 + v * (h / 2) * 0.9
          i ? g.lineTo(x, y) : g.moveTo(x, y)
        }
        g.stroke()
      }
      if (alive || playing) raf = requestAnimationFrame(draw)
    }
    draw()
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [engine, playing, mode])

  return (
    <button
      type="button"
      onClick={() => setMode((m) => (m === 'bars' ? 'wave' : 'bars'))}
      className={`block w-full rounded-lg ${className}`}
      aria-label={`Visualizer: ${mode}. Click to switch`}
      title="Switch visualizer"
    >
      <canvas ref={ref} className="h-full w-full" aria-hidden="true" />
    </button>
  )
}
