import { describe, expect, it } from 'vitest'
import { bytesSource } from '../source'
import { parseWav } from '../wav'
import { probeWav } from './wav'
import { buildFixture } from '../../../test-utils/fixtures'
import { buildMp3, buildRiff, countingSource, virtualSource, w32le } from '../../../test-utils/containers'
import type { RiffOptions } from '../../../test-utils/containers'

const probe = (bytes: Uint8Array) => probeWav(bytesSource(bytes))

describe('probeWav: stream properties', () => {
  it('reads plain 16-bit stereo PCM', async () => {
    const r = await probe(buildRiff({ frames: 88200 }))
    expect(r?.format).toMatchObject({ container: 'wav', codec: 'pcm', sampleRate: 44100, channels: 2, bitDepth: 16, bitrate: 1_411_200, lossless: true, vbr: false })
    expect(r?.duration).toBe(2)
    expect(r?.tags).toEqual({})
    expect(r?.picture).toBeNull()
  })

  const variants: [string, RiffOptions, Record<string, unknown>][] = [
    ['8-bit mono', { frames: 22050, channels: 1, bits: 8, sampleRate: 22050 }, { codec: 'pcm', bitDepth: 8, channels: 1, sampleRate: 22050, lossless: true }],
    ['24-bit', { frames: 48000, bits: 24, sampleRate: 48000 }, { codec: 'pcm', bitDepth: 24, lossless: true }],
    ['32-bit float', { frames: 48000, bits: 32, tag: 3, sampleRate: 48000 }, { codec: 'float', bitDepth: 32, lossless: true }],
    ['64-bit float', { frames: 48000, bits: 64, tag: 3, channels: 1, sampleRate: 48000 }, { codec: 'float', bitDepth: 64, lossless: true }],
    ['A-law', { frames: 48000, bits: 8, tag: 6, channels: 1, sampleRate: 48000 }, { codec: 'alaw', bitDepth: 8, lossless: false }],
    ['mu-law', { frames: 48000, bits: 8, tag: 7, channels: 1, sampleRate: 48000 }, { codec: 'mulaw', bitDepth: 8, lossless: false }],
    ['extensible format', { frames: 48000, bits: 24, channels: 6, sampleRate: 48000, extensible: true }, { codec: 'pcm', bitDepth: 24, channels: 6, lossless: true }],
  ]

  it.each(variants)('reads %s', async (_name, options, expected) => {
    const r = await probe(buildRiff(options))
    expect(r?.format).toMatchObject(expected)
    expect(r?.duration).toBeCloseTo(options.frames / (options.sampleRate ?? 44100), 6)
  })

  it('agrees with the decoder\'s own header parser on real fixtures', async () => {
    for (const name of ['tone-440', 'stereo-split', 'tone-24bit', 'tone-float', 'long'] as const) {
      const { bytes } = buildFixture(name)
      const info = parseWav(bytes)
      const r = await probe(bytes)
      expect(r?.duration).toBeCloseTo(info.frames / info.sampleRate, 9)
      expect(r?.format.sampleRate).toBe(info.sampleRate)
      expect(r?.format.channels).toBe(info.channels)
      expect(r?.format.bitDepth).toBe(info.bitsPerSample)
    }
  })
})

describe('probeWav: unusual layouts', () => {
  it('sizes a streaming file (data length left at 0) from the file itself', async () => {
    const r = await probe(buildRiff({ frames: 44100, streaming: true }))
    expect(r?.duration).toBe(1)
  })

  it('reads an RF64 file, taking the data size from ds64', async () => {
    const r = await probe(buildRiff({ frames: 88200, rf64: true }))
    expect(r?.duration).toBe(2)
    expect(r?.format.sampleRate).toBe(44100)
  })

  it('clamps a data chunk that promises more than the file holds', async () => {
    const r = await probe(buildRiff({ frames: 88200, cut: 44100 * 4 })) // the last second is missing
    expect(r?.duration).toBe(1)
  })

  it('finds the audio behind a large JUNK chunk without reading it', async () => {
    const counted = countingSource(bytesSource(buildRiff({ frames: 44100, junk: 200_000 })))
    const r = await probeWav(counted)
    expect(r?.duration).toBe(1)
    expect(counted.bytes).toBeLessThan(2048)
  })

  it('ignores the audio when it hops over it to trailing chunks', async () => {
    const counted = countingSource(bytesSource(buildRiff({ frames: 441000, info: { INAM: 'After' }, infoAfter: true })))
    const r = await probeWav(counted)
    expect(r?.tags.title).toBe('After')
    expect(r?.duration).toBe(10)
    expect(counted.bytes).toBeLessThan(4096)
  })

  it('reads only the header of a file declared 1 GB long', async () => {
    const small = buildRiff({ frames: 1000 })
    const patched = small.slice()
    patched.set(w32le(1_000_000_000), 40) // the size of the data chunk, right after a 16-byte fmt chunk
    const counted = countingSource(virtualSource(44 + 1_000_000_000, patched.slice(0, 44)))
    const r = await probeWav(counted)
    expect(r?.duration).toBeCloseTo(1_000_000_000 / (44100 * 4), 6)
    expect(counted.bytes).toBeLessThan(1024)
  })
})

describe('probeWav: LIST INFO tags', () => {
  const info = { INAM: 'Gece Yarısı', IART: 'Şebnem Ferah', IPRD: 'Aşk', ICRD: '2019-05-04', IGNR: 'Pop', ITRK: '3' }
  const expected = { title: 'Gece Yarısı', artist: 'Şebnem Ferah', album: 'Aşk', date: '2019-05-04', genre: 'Pop', track: '3' }

  it('reads the tags written before the audio', async () => {
    expect((await probe(buildRiff({ frames: 100, info })))?.tags).toEqual(expected)
  })

  it('reads the tags written after the audio', async () => {
    expect((await probe(buildRiff({ frames: 100, info, infoAfter: true })))?.tags).toEqual(expected)
  })

  it('handles odd-length values (chunks are padded to even sizes)', async () => {
    expect((await probe(buildRiff({ frames: 100, info: { INAM: 'abc', IART: 'de' } })))?.tags).toEqual({ title: 'abc', artist: 'de' })
  })

  it('leaves out empty values', async () => {
    expect((await probe(buildRiff({ frames: 100, info: { INAM: '  ', IART: 'x' } })))?.tags).toEqual({ artist: 'x' })
  })
})

describe('probeWav: not WAV', () => {
  it('returns null for other data', async () => {
    expect(await probe(new Uint8Array(0))).toBeNull()
    expect(await probe(new Uint8Array(100))).toBeNull()
    expect(await probe(buildMp3({ frames: 20 }))).toBeNull()
  })

  it('returns null for RIFF files that are not WAVE', async () => {
    const avi = buildRiff({ frames: 10 }).slice()
    avi.set([0x41, 0x56, 0x49, 0x20], 8) // "AVI "
    expect(await probe(avi)).toBeNull()
  })

  it('returns null without a usable fmt or data chunk', async () => {
    const wav = buildRiff({ frames: 100 })
    expect(await probe(wav.slice(0, 36))).toBeNull() // ends after the fmt chunk
    const noFmt = wav.slice()
    noFmt.set([0x78, 0x78, 0x78, 0x78], 12) // the fmt chunk is renamed
    expect(await probe(noFmt)).toBeNull()
    expect(await probe(buildRiff({ frames: 100, channels: 0 }))).toBeNull()
  })
})
