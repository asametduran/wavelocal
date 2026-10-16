import { describe, expect, it } from 'vitest'
import { bytesSource } from '../source'
import { probeMp4 } from './mp4'
import { buildMp3, buildMp4, countingSource, virtualSource, w64be } from '../../../test-utils/containers'
import type { Mp4Options } from '../../../test-utils/containers'

const probe = (bytes: Uint8Array) => probeMp4(bytesSource(bytes))
const ascii = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0))

function indexOfAscii(bytes: Uint8Array, s: string): number {
  const needle = ascii(s)
  for (let i = 0; i + needle.length <= bytes.length; i++) if (needle.every((b, j) => bytes[i + j] === b)) return i
  return -1
}

describe('probeMp4: audio properties', () => {
  it('reads an AAC track: duration, rate, channels and the configured bitrate', async () => {
    const r = await probe(buildMp4({ seconds: 215.5, codec: 'aac', sampleRate: 44100, channels: 2, avgBitrate: 256000 }))
    expect(r?.format).toMatchObject({ container: 'mp4', codec: 'aac', sampleRate: 44100, channels: 2, bitrate: 256000, lossless: false, bitDepth: 0 })
    expect(r?.duration).toBeCloseTo(215.5, 4)
    expect(r?.tags).toEqual({})
    expect(r?.picture).toBeNull()
  })

  it('sees mono and an MP3 stream inside an MP4 container', async () => {
    expect((await probe(buildMp4({ seconds: 10, channels: 1 })))?.format.channels).toBe(1)
    expect((await probe(buildMp4({ seconds: 10, codec: 'mp3', avgBitrate: 192000 })))?.format).toMatchObject({ codec: 'mp3', bitrate: 192000 })
  })

  it('reads Apple Lossless: bit depth, the sample rate the 16.16 field cannot hold, and a real bitrate', async () => {
    // encoders write the uncompressed rate (96000 x 24 x 2) into the cookie, which says nothing about the file
    const r = await probe(buildMp4({ seconds: 20, codec: 'alac', sampleRate: 96000, bitDepth: 24, channels: 2, avgBitrate: 4_608_000, mdatBytes: 5_000_000 }))
    expect(r?.format).toMatchObject({ codec: 'alac', sampleRate: 96000, bitDepth: 24, channels: 2, bitrate: 2_000_000, lossless: true })
    expect(r?.duration).toBeCloseTo(20, 4)
  })

  it('uses the track duration, which accounts for the edit list, rather than the longer media duration (AAC priming)', async () => {
    const r = await probe(buildMp4({ seconds: 6.1, sampleRate: 44100, priming: 1024 })) // the media itself is 6.1232 s long
    expect(r?.duration).toBeCloseTo(6.1, 4)
  })

  it('works out the bitrate from the media data when no codec box states one', async () => {
    const r = await probe(buildMp4({ seconds: 20, codec: 'aac', avgBitrate: 0, mdatBytes: 1_000_000 }))
    expect(r?.format.bitrate).toBe(400_000)
  })

  it('takes the bitrate from the sample size table, which beats a placeholder in the codec box', async () => {
    // modelled on a real file: Steam's AAC sounds all declare 256000 in esds while their samples add up to 25,581 bytes in 1.207 s
    const sizes = [...Array.from({ length: 51 }, () => 500), 81]
    const r = await probe(buildMp4({ seconds: 1.207, avgBitrate: 256000, samples: sizes }))
    expect(r?.format.bitrate).toBe(Math.round((25_581 * 8) / 1.207))
  })

  it('sums a constant sample size without a table', async () => {
    const r = await probe(buildMp4({ seconds: 10, avgBitrate: 256000, samples: { count: 500, size: 400 } }))
    expect(r?.format.bitrate).toBe(160_000)
  })
})

describe('probeMp4: layouts', () => {
  const layouts: [string, Partial<Mp4Options>][] = [
    ['moov before mdat (streaming layout)', {}],
    ['moov after mdat', { moovAtEnd: true }],
    ['64-bit time fields', { version1: true }],
    ['64-bit mdat size', { largeMdat: true, moovAtEnd: true }],
    ['a free box in front', { freeBefore: 4000 }],
    ['a different movie time scale', { movieTimescale: 600 }],
    ['a video track before the audio track', { videoTrackFirst: true }],
    ['everything at once', { moovAtEnd: true, version1: true, largeMdat: true, freeBefore: 100, videoTrackFirst: true, movieTimescale: 90000 }],
  ]

  it.each(layouts)('finds the audio in a file with %s', async (_name, options) => {
    const r = await probe(buildMp4({ seconds: 187.25, codec: 'aac', sampleRate: 48000, channels: 2, avgBitrate: 128000, ...options }))
    expect(r?.duration).toBeCloseTo(187.25, 3)
    expect(r?.format).toMatchObject({ codec: 'aac', sampleRate: 48000, channels: 2, bitrate: 128000 })
  })

  it('falls back to the movie duration when the audio track does not carry one', async () => {
    const r = await probe(buildMp4({ seconds: 99.5, noMediaDuration: true }))
    expect(r?.duration).toBeCloseTo(99.5, 3)
  })

  it('accepts a QuickTime-style file that starts straight with moov', async () => {
    const whole = buildMp4({ seconds: 30 })
    const noFtyp = whole.slice(indexOfAscii(whole, 'moov') - 4)
    expect((await probe(noFtyp))?.duration).toBeCloseTo(30, 3)
  })
})

describe('probeMp4: damaged and foreign files', () => {
  it('still has the audio when only the media data is cut off', async () => {
    const whole = buildMp4({ seconds: 60, mdatBytes: 50_000 })
    const r = await probe(whole.slice(0, whole.length - 30_000))
    expect(r?.duration).toBeCloseTo(60, 3)
  })

  it('keeps the movie duration when the end of a late moov is lost', async () => {
    const whole = buildMp4({ seconds: 60, moovAtEnd: true })
    const r = await probe(whole.slice(0, whole.length - 100))
    expect(r?.duration).toBeCloseTo(60, 3)
  })

  it('returns null for data that is not MP4', async () => {
    expect(await probe(new Uint8Array(0))).toBeNull()
    expect(await probe(new Uint8Array(2000))).toBeNull()
    expect(await probe(buildMp3({ frames: 50 }))).toBeNull()
    expect(await probe(Uint8Array.from(ascii('this is just some text, not a media file at all')))).toBeNull()
  })

  it('returns null for a container with no moov box', async () => {
    const whole = buildMp4({ seconds: 10 })
    expect(await probe(whole.slice(0, indexOfAscii(whole, 'moov') - 4))).toBeNull()
  })

  it('does not loop on a box that claims to be smaller than its own header', async () => {
    const bad = Uint8Array.from([0, 0, 0, 4, ...ascii('free'), ...new Array<number>(40).fill(0)])
    expect(await probe(bad)).toBeNull()
  })
})

describe('probeMp4: cost', () => {
  it('hops over a 500 MB mdat and reads only box headers and the late moov', async () => {
    const small = buildMp4({ seconds: 120, moovAtEnd: true, largeMdat: true, mdatBytes: 16, avgBitrate: 0 })
    const mdat = indexOfAscii(small, 'mdat') - 4
    const payload = 500 * 1024 * 1024
    const patched = small.slice()
    patched.set(w64be(16 + payload), mdat + 8) // the 64-bit size of the mdat box
    const head = patched.slice(0, mdat + 16)
    const moov = patched.slice(mdat + 16 + 16)
    const counted = countingSource(virtualSource(head.length + payload + moov.length, head, moov))
    const r = await probeMp4(counted)
    expect(r?.duration).toBeCloseTo(120, 3)
    expect(r?.format.bitrate).toBe(Math.round((payload * 8) / 120))
    expect(counted.bytes).toBeLessThan(4096)
    expect(counted.reads).toBeLessThan(12)
  })
})
