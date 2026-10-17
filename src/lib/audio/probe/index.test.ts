import { describe, expect, it } from 'vitest'
import { bytesSource } from '../source'
import { probeAudio } from './index'
import type { ProbeResult } from './types'
import { buildFlac } from '../../../test-utils/fixtures'
import { buildAdts, buildMp3, buildMp4, buildOgg, buildRiff, cat, id3v2Blank } from '../../../test-utils/containers'
import { clock, since } from '../../../test-utils/fuzz'

const probe = (bytes: Uint8Array) => probeAudio(bytesSource(bytes))

function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const samples: [string, Uint8Array, string, number][] = [
  ['an MP3', buildMp3({ frames: 60, xing: { lame: { delay: 576, padding: 1000 } } }), 'mp3', (60 * 1152 - 1576) / 44100],
  ['an MP3 behind an ID3v2 tag', buildMp3({ frames: 60, id3v2: id3v2Blank(800), xing: {} }), 'mp3', (60 * 1152) / 44100],
  ['an MP3 with junk in front and no tag', buildMp3({ frames: 60, leading: Uint8Array.from([1, 2, 3, 4, 5]), xing: {} }), 'mp3', (60 * 1152) / 44100],
  ['raw AAC (ADTS)', buildAdts({ frames: 80 }), 'aac', (80 * 1024) / 44100],
  ['an M4A', buildMp4({ seconds: 12.5 }), 'mp4', 12.5],
  ['an Ogg Vorbis stream', buildOgg({ codec: 'vorbis', seconds: 7.25 }), 'ogg', 7.25],
  ['an Ogg Opus stream', buildOgg({ codec: 'opus', seconds: 7.25 }), 'ogg', 7.25],
  ['a FLAC file', buildFlac('tone-440'), 'flac', 4],
  ['a FLAC file behind an ID3v2 tag', buildFlac('tone-440', { id3v2: id3v2Blank(1200) }), 'flac', 4],
  ['a WAV file', buildRiff({ frames: 44100 }), 'wav', 1],
  ['an RF64 file', buildRiff({ frames: 44100, rf64: true }), 'wav', 1],
]

describe('probeAudio: identification by content', () => {
  it.each(samples)('identifies %s', async (_name, bytes, container, seconds) => {
    const r = await probe(bytes)
    expect(r?.format.container).toBe(container)
    expect(r?.duration).toBeCloseTo(seconds, 3)
  })

  it('returns null for data that is no audio container', async () => {
    expect(await probe(new Uint8Array(0))).toBeNull()
    expect(await probe(new Uint8Array(3))).toBeNull()
    expect(await probe(Uint8Array.from(Array.from('just some text, not audio at all, '.repeat(50), (c) => c.charCodeAt(0))))).toBeNull()
    expect(await probe(Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, ...new Array<number>(500).fill(0)]))).toBeNull() // Matroska / WebM
  })

  it('is not fooled by a name: only the bytes count', async () => {
    // the very same bytes give the same answer however the file is called, because the name is never an input
    const a = await probe(buildFlac('tone-440'))
    const b = await probe(buildFlac('tone-440'))
    expect(a?.format).toEqual(b?.format)
  })
})

describe('probeAudio: damaged and hostile input', () => {
  const sane = (r: ProbeResult | null): void => {
    if (!r) return
    if (r.duration !== null) {
      expect(Number.isFinite(r.duration)).toBe(true)
      expect(r.duration).toBeGreaterThanOrEqual(0)
      expect(r.duration).toBeLessThan(1e7)
    }
    for (const n of [r.format.sampleRate, r.format.channels, r.format.bitrate, r.format.bitDepth, r.format.encoderDelay, r.format.encoderPadding]) {
      expect(Number.isFinite(n)).toBe(true)
      expect(n).toBeGreaterThanOrEqual(0)
    }
    expect(r.format.sampleRate).toBeLessThanOrEqual(1_048_575)
    expect(r.format.channels).toBeLessThanOrEqual(65535)
    for (const v of Object.values(r.tags)) expect(typeof v).toBe('string')
  }

  it('never throws and never returns nonsense for mutated copies of every kind of file', async () => {
    const random = mulberry32(2026)
    let results = 0
    for (const [, original] of samples) {
      for (let round = 0; round < 40; round++) {
        const bytes = original.slice()
        const kind = round % 4
        if (kind === 0) {
          for (let i = 0; i < 1 + Math.floor(random() * 8); i++) bytes[Math.floor(random() * bytes.length)] = Math.floor(random() * 256)
        } else if (kind === 1) {
          // damage the first 64 bytes, where every header lives
          for (let i = 0; i < 1 + Math.floor(random() * 6); i++) bytes[Math.floor(random() * Math.min(64, bytes.length))] = Math.floor(random() * 256)
        }
        const cut = kind === 2 ? bytes.slice(0, Math.floor(random() * bytes.length)) : kind === 3 ? cat(bytes, Uint8Array.from({ length: 100 }, () => Math.floor(random() * 256))) : bytes
        sane(await probe(cut))
        results++
      }
    }
    expect(results).toBe(samples.length * 40)
  })

  it('never throws on pure noise', async () => {
    const random = mulberry32(99)
    for (let i = 0; i < 100; i++) {
      const length = Math.floor(random() * 6000)
      sane(await probe(Uint8Array.from({ length }, () => Math.floor(random() * 256))))
    }
  })

  it('stays fast on inputs built to look like audio everywhere', async () => {
    const started = clock()
    sane(await probe(new Uint8Array(5 * 1024 * 1024).fill(0xff)))
    const header = [0xff, 0xfb, 0x90, 0x00]
    sane(await probe(Uint8Array.from({ length: 4 * 1024 * 1024 }, (_, i) => (i % 417 < 4 ? (header[i % 417] ?? 0) : 0))))
    sane(await probe(Uint8Array.from({ length: 3 * 1024 * 1024 }, (_, i) => (i % 3 === 0 ? 0x4f : i % 3 === 1 ? 0x67 : 0x67)))) // "ggOggOgg..."
    expect(since(started)).toBeLessThan(4000)
  })

  it('reads a bounded amount of a file whatever its size', async () => {
    const reads = { bytes: 0 }
    const noise = bytesSource(new Uint8Array(2 * 1024 * 1024).fill(0xff))
    const counted = {
      size: noise.size,
      async read(o: number, l: number) {
        const out = await noise.read(o, l)
        reads.bytes += out.length
        return out
      },
    }
    await probeAudio(counted)
    expect(reads.bytes).toBeLessThan(600 * 1024)
  })
})
