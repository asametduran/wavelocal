import type { AudioFormat } from './audio/probe/types'

/** Format seconds as `m:ss`; invalid or negative input renders as `0:00`. */
export function formatTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) return '0:00'
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${String(sec).padStart(2, '0')}`
}

/** A total length for a list: "42 min", "3 h 30 min"; empty when there is nothing to say. */
export function formatTotal(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return ''
  if (seconds < 60) return '< 1 min'
  const minutes = Math.floor(seconds / 60)
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return h ? (m ? `${h} h ${m} min` : `${h} h`) : `${m} min`
}

// ---- audio format ----

const CODEC_LABELS: Record<string, string> = { mp1: 'MP1', mp2: 'MP2', mp3: 'MP3', aac: 'AAC', alac: 'ALAC', vorbis: 'Vorbis', opus: 'Opus', flac: 'FLAC' }
const WAV_CODECS = new Set(['pcm', 'float', 'alaw', 'mulaw'])

const codecLabel = (a: AudioFormat): string => (WAV_CODECS.has(a.codec) ? 'WAV' : (CODEC_LABELS[a.codec] ?? a.container.toUpperCase()))
/** 44100 is "44.1", 48000 is "48", 22050 is "22.05". */
const kilohertz = (rate: number): string => String(Number((rate / 1000).toFixed(3)))
const depth = (a: AudioFormat): string => (a.bitDepth ? `${a.bitDepth}-bit${a.codec === 'float' ? ' float' : ''}` : '')
const kbps = (a: AudioFormat): number => Math.round(a.bitrate / 1000)

/** "FLAC · 96 kHz · 24-bit", "MP3 · 320 kbps", "Opus · 74 kbps VBR": what a file is, in a few words; empty when unknown. */
export function formatBadge(audio: AudioFormat | null | undefined): string {
  if (!audio) return ''
  const parts = [codecLabel(audio)]
  if (audio.lossless) {
    if (audio.sampleRate) parts.push(`${kilohertz(audio.sampleRate)} kHz`)
    if (audio.bitDepth) parts.push(depth(audio))
  } else if (audio.bitrate) {
    parts.push(`${kbps(audio)} kbps${audio.vbr ? ' VBR' : ''}`)
  }
  return parts.join(' · ')
}

/** Lossless audio above CD quality, in sample rate or bit depth. */
export const isHiRes = (audio: AudioFormat | null | undefined): boolean => Boolean(audio?.lossless && (audio.sampleRate > 48000 || audio.bitDepth > 16))

/** The format as a screen reader should say it ("FLAC, 96 kilohertz, 24-bit"). */
export function spokenFormat(audio: AudioFormat | null | undefined): string {
  if (!audio) return ''
  const parts = [codecLabel(audio)]
  if (audio.lossless) {
    if (audio.sampleRate) parts.push(`${kilohertz(audio.sampleRate)} kilohertz`)
    if (audio.bitDepth) parts.push(depth(audio))
  } else if (audio.bitrate) {
    parts.push(`${kbps(audio)} kilobits per second`)
    if (audio.vbr) parts.push('variable bitrate')
  }
  return parts.join(', ')
}

function hash(str: string): number {
  let h = 2166136261
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619)
  return h >>> 0
}

/** Deterministic procedural artwork gradient for tracks with no embedded cover. */
export function fallbackGradient(seed = ''): string {
  const h = hash(seed)
  const h1 = h % 360
  const h2 = (h1 + 40 + ((h >> 8) % 90)) % 360
  const h3 = (h2 + 60 + ((h >> 16) % 60)) % 360
  const angle = (h >> 4) % 360
  return `radial-gradient(circle at 25% 20%, hsl(${h3} 80% 62% / .9), transparent 55%), linear-gradient(${angle}deg, hsl(${h1} 70% 45%), hsl(${h2} 75% 30%))`
}
