import { describe, expect, it } from 'vitest'
import { FIXTURE_NAMES, buildFixture, fixtureFile, lrcText } from './fixtures'
import { clippedSamples, estimateFrequency, peak, rmsDbfs } from './signals'
import { decodeWav } from './wav'
import { gainFromSamples } from '../lib/loudness'
import { parseLrc } from '../lib/lrc'

const decode = (name: Parameters<typeof buildFixture>[0]) => decodeWav(buildFixture(name).bytes)
const ch = (name: Parameters<typeof buildFixture>[0], index = 0) => decode(name).channels[index]!

describe('fixture catalog', () => {
  it('has unique, well-formed names and small files', () => {
    expect(new Set(FIXTURE_NAMES).size).toBe(FIXTURE_NAMES.length)
    for (const name of FIXTURE_NAMES) {
      const f = buildFixture(name)
      expect(f.fileName).toBe(`${name}.wav`)
      expect(f.description.length).toBeGreaterThan(5)
      expect(f.bytes.length).toBeLessThan(1_000_000)
    }
  })

  it.each(FIXTURE_NAMES)('%s decodes to the declared shape', (name) => {
    const f = buildFixture(name)
    const d = decodeWav(f.bytes)
    expect(d.sampleRate).toBe(f.sampleRate)
    expect(d.format).toBe(f.format)
    expect(d.channels).toHaveLength(f.channels)
    expect(d.channels[0]!.length / d.sampleRate).toBeCloseTo(f.seconds, 2)
  })

  it('is deterministic: a fixture always has identical bytes', () => {
    // plain loop: deep-equal on hundreds of KB of typed array is needlessly slow
    const same = (x: Uint8Array, y: Uint8Array) => x.length === y.length && x.every((v, i) => v === y[i])
    for (const name of FIXTURE_NAMES) expect(same(buildFixture(name).bytes, buildFixture(name).bytes)).toBe(true)
  })

  it('wraps a fixture in a File with a stable key', () => {
    const a = fixtureFile('tone-440')
    const b = fixtureFile('tone-440')
    expect(a.type).toBe('audio/wav')
    expect(a.name).toBe('tone-440.wav')
    expect(a.lastModified).toBe(b.lastModified)
    expect(a.size).toBe(b.size)
    expect(fixtureFile('tone-440', 'renamed.wav').name).toBe('renamed.wav')
  })
})

describe('fixture content', () => {
  it('tones have the right pitch and level', () => {
    expect(estimateFrequency(ch('tone-440'))).toBeCloseTo(440, 0)
    expect(estimateFrequency(ch('tone-880'))).toBeCloseTo(880, 0)
    expect(peak(ch('tone-440'))).toBeCloseTo(0.5, 2)
  })

  it('stereo-split carries different tones per channel', () => {
    expect(estimateFrequency(ch('stereo-split', 0))).toBeCloseTo(440, 0)
    expect(estimateFrequency(ch('stereo-split', 1))).toBeCloseTo(880, 0)
  })

  it('silence is silent', () => {
    expect(peak(ch('silence'))).toBe(0)
  })

  it('clipped really clips', () => {
    expect(clippedSamples(ch('clipped'))).toBeGreaterThan(ch('clipped').length / 2)
  })

  it('24-bit and float versions match the 16-bit tone', () => {
    const reference = ch('tone-440')
    for (const name of ['tone-24bit', 'tone-float'] as const) {
      const other = ch(name)
      for (let i = 0; i < 2000; i++) expect(Math.abs((other[i] ?? 0) - (reference[i] ?? 0))).toBeLessThan(2 / 32768)
    }
  })

  it('loud, quiet and loud-then-quiet sit at their documented RMS levels', () => {
    expect(rmsDbfs(ch('loud'))).toBeCloseTo(-8, 1)
    expect(rmsDbfs(ch('quiet'))).toBeCloseTo(-30, 1)
    const mixed = ch('loud-then-quiet')
    const half = Math.floor(mixed.length / 2)
    expect(rmsDbfs(mixed.subarray(0, half))).toBeCloseTo(-8, 1)
    expect(rmsDbfs(mixed.subarray(half))).toBeCloseTo(-30, 1)
  })
})

describe('loudness normalization on synthetic audio', () => {
  const afterGain = (name: Parameters<typeof buildFixture>[0]) => {
    const samples = ch(name)
    const gain = gainFromSamples(samples)
    return { gain, level: rmsDbfs(samples) + gain, peak: peak(samples) * 10 ** (gain / 20) }
  }

  it('boosts the quiet track and cuts the loud one', () => {
    expect(afterGain('quiet').gain).toBeGreaterThan(0)
    expect(afterGain('loud').gain).toBeLessThan(0)
  })

  it('brings differently loud tracks to the same level', () => {
    expect(afterGain('quiet').level).toBeCloseTo(-18, 0)
    expect(afterGain('loud').level).toBeCloseTo(-18, 0)
    expect(Math.abs(afterGain('quiet').level - afterGain('loud').level)).toBeLessThan(0.3)
  })

  it('never pushes any fixture past full scale', () => {
    for (const name of FIXTURE_NAMES) expect(afterGain(name).peak).toBeLessThanOrEqual(1.0001)
  })

  it('leaves silence untouched', () => {
    expect(afterGain('silence').gain).toBe(0)
  })

  it('does not boost the clipped track', () => {
    expect(afterGain('clipped').gain).toBeLessThanOrEqual(0)
  })
})

describe('lrcText', () => {
  it('formats [mm:ss.xx] stamps that parseLrc reads back', () => {
    const text = lrcText([
      [0, 'intro'],
      [65.25, 'verse'],
      [600, 'end'],
    ])
    expect(text).toBe('[00:00.00]intro\n[01:05.25]verse\n[10:00.00]end')
    expect(parseLrc(text)?.lines.map((l) => l.t)).toEqual([0, 65.25, 600])
  })
})
