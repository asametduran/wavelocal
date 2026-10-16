import { describe, expect, it } from 'vitest'
import { bytesSource } from '../source'
import { probeAdts } from './adts'
import { buildAdts, buildMp3, cat, countingSource, id3v2Blank } from '../../../test-utils/containers'

const probe = (bytes: Uint8Array, options?: Parameters<typeof probeAdts>[1]) => probeAdts(bytesSource(bytes), options)

describe('probeAdts', () => {
  it('counts the frames of a raw AAC stream: 1024 samples each', async () => {
    const r = await probe(buildAdts({ frames: 5000, sampleRate: 44100, channels: 2, frameBytes: 400 }))
    expect(r?.format).toMatchObject({ container: 'aac', codec: 'aac', sampleRate: 44100, channels: 2, lossless: false })
    expect(r?.duration).toBeCloseTo((5000 * 1024) / 44100, 6)
    expect(r?.format.bitrate).toBeGreaterThan(137_000) // 400 bytes every 23.2 ms
    expect(r?.format.bitrate).toBeLessThan(138_500)
  })

  it.each([
    [22050, 1],
    [48000, 6],
    [8000, 2],
  ])('reads %d Hz with %d channel(s)', async (sampleRate, channels) => {
    const r = await probe(buildAdts({ frames: 400, sampleRate, channels }))
    expect(r?.format).toMatchObject({ sampleRate, channels })
    expect(r?.duration).toBeCloseTo((400 * 1024) / sampleRate, 6)
  })

  it('skips an ID3v2 tag in front of the stream', async () => {
    const r = await probe(buildAdts({ frames: 300, id3v2: id3v2Blank(1500) }))
    expect(r?.duration).toBeCloseTo((300 * 1024) / 44100, 6)
  })

  it('keeps the frames that are there when a download was cut short', async () => {
    const r = await probe(buildAdts({ frames: 1000, cutBytes: 150 }))
    expect(r?.duration).toBeGreaterThan((999 * 1024) / 44100 - 0.001)
    expect(r?.duration).toBeLessThan((1000 * 1024) / 44100 + 0.001)
  })

  it('extrapolates a long stream after the scan budget without reading all of it', async () => {
    const bytes = buildAdts({ frames: 5000 }) // 2 MB
    const counted = countingSource(bytesSource(bytes))
    const r = await probeAdts(counted, { maxScanBytes: 100_000 })
    expect(counted.bytes).toBeLessThan(400_000)
    expect(r?.duration).toBeGreaterThan(((5000 * 1024) / 44100) * 0.99)
    expect(r?.duration).toBeLessThan(((5000 * 1024) / 44100) * 1.01)
  })

  it('returns null for other data, including MP3 (whose layer bits differ)', async () => {
    expect(await probe(new Uint8Array(0))).toBeNull()
    expect(await probe(new Uint8Array(5000))).toBeNull()
    expect(await probe(buildMp3({ frames: 100 }))).toBeNull()
    expect(await probe(id3v2Blank(2000))).toBeNull()
  })

  it('returns null for a lone header that no other frame follows', async () => {
    const one = buildAdts({ frames: 5 })
    expect(await probe(cat(one.slice(0, 7), new Uint8Array(900).fill(0x11)))).toBeNull()
  })
})
