export function formatTime(s) {
  if (!Number.isFinite(s) || s < 0) return '0:00'
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${String(sec).padStart(2, '0')}`
}

function hash(str) {
  let h = 2166136261
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619)
  return h >>> 0
}

/** Deterministic procedural artwork gradient for tracks with no embedded cover. */
export function fallbackGradient(seed = '') {
  const h = hash(seed)
  const h1 = h % 360
  const h2 = (h1 + 40 + ((h >> 8) % 90)) % 360
  const h3 = (h2 + 60 + ((h >> 16) % 60)) % 360
  const angle = (h >> 4) % 360
  return `radial-gradient(circle at 25% 20%, hsl(${h3} 80% 62% / .9), transparent 55%), linear-gradient(${angle}deg, hsl(${h1} 70% 45%), hsl(${h2} 75% 30%))`
}
