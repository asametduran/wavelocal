import { describe, expect, it } from 'vitest'
import { encodeFlac } from '../../test-utils/flac-encoder'
import { encodeWav } from '../../test-utils/wav'
import { browserPlaysContainer, mightBeLossless, needsDecoder, sniffBlob, sniffContainer, wavNeedsDecoder } from './sniff'

const flac = () => encodeFlac([Int32Array.from({ length: 2000 }, (_, i) => Math.round(Math.sin(i / 10) * 8000))], { sampleRate: 44100, bitsPerSample: 16 })
const wav = (format: 'pcm16' | 'pcm24' | 'float32' = 'pcm16') => encodeWav([Float32Array.from({ length: 1000 }, (_, i) => Math.sin(i / 8) * 0.5)], { format })

const element = (supported: string[]) => ({ canPlayType: (type: string) => (supported.includes(type) ? 'probably' : '') })

describe('sniffContainer', () => {
  it('identifies WAV and FLAC by their signatures, not their names', () => {
    expect(sniffContainer(wav())).toBe('wav')
    expect(sniffContainer(flac())).toBe('flac')
  })

  it('leaves everything else alone', () => {
    expect(sniffContainer(new Uint8Array(64))).toBe('other')
    expect(sniffContainer(Uint8Array.of(0xff, 0xfb, 0x90, 0x00))).toBe('other') // an MP3 frame
    expect(sniffContainer(new Uint8Array(0))).toBe('other')
  })
})

describe('sniffBlob', () => {
  it('reads the container from a Blob', async () => {
    expect((await sniffBlob(new Blob([wav()]))).container).toBe('wav')
    expect((await sniffBlob(new Blob([flac()]))).container).toBe('flac')
    expect((await sniffBlob(new Blob([new Uint8Array(500)]))).container).toBe('other')
  })

  it('finds FLAC behind a large ID3v2 tag', async () => {
    const id3 = new Uint8Array(10 + 20000)
    id3.set([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0x9c, 0x40]) // size 20000 as syncsafe: (0x9c-?)... computed below
    const size = 20000
    id3[6] = (size >> 21) & 0x7f
    id3[7] = (size >> 14) & 0x7f
    id3[8] = (size >> 7) & 0x7f
    id3[9] = size & 0x7f
    const inner = flac()
    const file = new Uint8Array(id3.length + inner.length)
    file.set(id3)
    file.set(inner, id3.length)
    expect((await sniffBlob(new Blob([file]))).container).toBe('flac')
  })

  it('does not mistake an MP3 with an ID3 tag for FLAC', async () => {
    const mp3 = new Uint8Array(300)
    mp3.set([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 20])
    expect((await sniffBlob(new Blob([mp3]))).container).toBe('other')
  })
})

describe('mightBeLossless (the synchronous guess)', () => {
  it.each([
    [{ name: 'a.wav' }, true],
    [{ name: 'A.FLAC' }, true],
    [{ name: 'song.wave' }, true],
    [{ name: 'noname', type: 'audio/flac' }, true],
    [{ name: 'noname', type: 'audio/x-wav' }, true],
    [{ name: 'a.mp3', type: 'audio/mpeg' }, false],
    [{ name: 'a.m4a' }, false],
    [{ name: 'awav' }, false],
    [{}, false],
  ])('%j -> %s', (file, expected) => {
    expect(mightBeLossless(file)).toBe(expected)
  })
})

describe('browserPlaysContainer', () => {
  it('trusts canPlayType', () => {
    expect(browserPlaysContainer('flac', element(['audio/flac']))).toBe(true)
    expect(browserPlaysContainer('flac', element(['audio/x-flac']))).toBe(true)
    expect(browserPlaysContainer('flac', element([]))).toBe(false)
    expect(browserPlaysContainer('wav', element(['audio/wav']))).toBe(true)
    expect(browserPlaysContainer('wav', element(['audio/x-wav']))).toBe(true)
    expect(browserPlaysContainer('wav', element(['audio/wave']))).toBe(true)
    expect(browserPlaysContainer('wav', element([]))).toBe(false)
  })

  it('counts "maybe" as support', () => {
    expect(browserPlaysContainer('wav', { canPlayType: () => 'maybe' })).toBe(true)
  })

  it('assumes support for other containers and when there is nothing to ask', () => {
    expect(browserPlaysContainer('other', element([]))).toBe(true)
    expect(browserPlaysContainer('flac', null)).toBe(true)
  })
})

describe('wavNeedsDecoder', () => {
  it('leaves ordinary WAV files to the browser', () => {
    expect(wavNeedsDecoder(wav('pcm16'))).toBe(false)
    expect(wavNeedsDecoder(wav('pcm24'))).toBe(false)
    expect(wavNeedsDecoder(wav('float32'))).toBe(false)
  })

  it('claims the flavours browsers commonly refuse', () => {
    const f64 = new Uint8Array(44 + 16)
    const v = new DataView(f64.buffer)
    f64.set([0x52, 0x49, 0x46, 0x46], 0)
    v.setUint32(4, 36 + 16, true)
    f64.set([0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20], 8)
    v.setUint32(16, 16, true)
    v.setUint16(20, 3, true)
    v.setUint16(22, 1, true)
    v.setUint32(24, 44100, true)
    v.setUint32(28, 44100 * 8, true)
    v.setUint16(32, 8, true)
    v.setUint16(34, 64, true)
    f64.set([0x64, 0x61, 0x74, 0x61], 36)
    v.setUint32(40, 16, true)
    expect(wavNeedsDecoder(f64)).toBe(true)
  })

  it('does not claim data it cannot parse', () => {
    expect(wavNeedsDecoder(new Uint8Array(100))).toBe(false)
  })
})

describe('needsDecoder', () => {
  it('is false for anything that is not WAV or FLAC', () => {
    expect(needsDecoder('other', new Uint8Array(10), element([]))).toBe(false)
  })

  it('is true when the browser does not play the container', () => {
    expect(needsDecoder('flac', flac(), element([]))).toBe(true)
    expect(needsDecoder('wav', wav(), element([]))).toBe(true)
  })

  it('is false when the browser plays it', () => {
    expect(needsDecoder('flac', flac(), element(['audio/flac']))).toBe(false)
    expect(needsDecoder('wav', wav(), element(['audio/wav']))).toBe(false)
  })

  it('is true for exotic WAV flavours even though the browser plays WAV', () => {
    const rf64 = wav().slice()
    rf64.set([0x52, 0x46, 0x36, 0x34], 0)
    expect(needsDecoder('wav', rf64, element(['audio/wav']))).toBe(true)
  })
})
