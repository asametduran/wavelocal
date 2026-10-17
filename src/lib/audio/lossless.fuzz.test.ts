import { describe, expect, it } from 'vitest'
import { parseWav, wavChunks } from './wav'
import { decodeFlac, parseFlacMetadata } from './flac'
import { AudioDecodeError } from './pcm'
import { encodeWav } from '../../test-utils/wav'
import { buildFlac } from '../../test-utils/fixtures'
import { sine } from '../../test-utils/signals'
import { FUZZ_TIMEOUT, eachSeed, int, mutateBytes, pick, randomBytes, timed } from '../../test-utils/fuzz'

const tone = (seconds: number) => sine({ frequency: 440, amplitude: 0.4, seconds })
const WAVS = [encodeWav([tone(0.05)]), encodeWav([tone(0.03), tone(0.03)], { format: 'pcm24' }), encodeWav([tone(0.02)], { format: 'float32' }), encodeWav([tone(0.02), tone(0.02), tone(0.02)])]
const FLAC = buildFlac('tone-440')

/** The only way a decoder may refuse a file: with its own error, never an accident. */
function onlyDecodeErrors(error: unknown): void {
  expect(error, error instanceof Error ? `${error.name}: ${error.message}` : String(error)).toBeInstanceOf(AudioDecodeError)
}

function readsOrRefuses(bytes: Uint8Array): void {
  let info
  try {
    info = parseWav(bytes)
  } catch (error) {
    return onlyDecodeErrors(error)
  }
  expect(info.channels).toBeGreaterThanOrEqual(1)
  expect(info.sampleRate).toBeGreaterThanOrEqual(1)
  expect(info.blockAlign).toBeGreaterThan(0)
  expect(info.dataOffset + info.dataBytes).toBeLessThanOrEqual(bytes.length)
  expect(info.frames * info.blockAlign).toBeLessThanOrEqual(info.dataBytes)
  let frames = 0
  for (const chunk of wavChunks(bytes, info, 4096)) {
    expect(chunk).toHaveLength(info.channels)
    frames += chunk[0]?.length ?? 0
    for (const channel of chunk) for (let i = 0; i < channel.length; i++) if (Number.isNaN(channel[i])) throw new Error('a sample is NaN')
  }
  expect(frames).toBe(info.frames)
}

function decodesOrRefuses(bytes: Uint8Array): void {
  try {
    const decoded = decodeFlac(bytes)
    expect(decoded.pcm).toHaveLength(decoded.channels)
    for (const channel of decoded.pcm) expect(channel.length).toBe(decoded.length)
    expect(decoded.sampleRate).toBeGreaterThan(0)
    expect(decoded.channels).toBeGreaterThanOrEqual(1)
    expect(decoded.bitsPerSample).toBeGreaterThanOrEqual(4)
    expect(decoded.bitsPerSample).toBeLessThanOrEqual(32)
  } catch (error) {
    onlyDecodeErrors(error)
  }
}

describe('lossless decoders under fuzzing', { timeout: FUZZ_TIMEOUT }, () => {
  it('read or refuse damaged WAV files, and nothing in between', async () => {
    await eachSeed(500, (random) => readsOrRefuses(mutateBytes(random, mutateBytes(random, pick(random, WAVS)))))
  })

  it('refuse random bytes and bytes that begin like a WAV file', async () => {
    await eachSeed(300, (random) => {
      readsOrRefuses(randomBytes(random, int(random, 300)))
      readsOrRefuses(Uint8Array.from([...new TextEncoder().encode('RIFF'), ...randomBytes(random, 4), ...new TextEncoder().encode('WAVE'), ...randomBytes(random, int(random, 200))]))
      readsOrRefuses(Uint8Array.from([...new TextEncoder().encode('RF64'), ...randomBytes(random, 4), ...new TextEncoder().encode('WAVE'), ...randomBytes(random, int(random, 200))]))
    })
  })

  it('never believe a header that promises far more audio than the file holds', () => {
    const wav = Uint8Array.from(WAVS[0] as Uint8Array)
    const view = new DataView(wav.buffer)
    for (const claimed of [0xffffffff, 0x7fffffff, 0x10000000]) {
      view.setUint32(40, claimed, true) // the size of the data chunk
      const info = parseWav(wav)
      expect(info.frames * info.blockAlign).toBeLessThanOrEqual(wav.length)
      // 0xFFFFFFFF is how a stream that does not know its length writes it: the audio then simply runs to the end of the file
      expect(info.truncated).toBe(claimed !== 0xffffffff)
      readsOrRefuses(wav)
    }
  })

  it('decode or refuse damaged FLAC files, and nothing in between', async () => {
    await eachSeed(300, (random) => {
      const { ms } = timed(() => decodesOrRefuses(mutateBytes(random, mutateBytes(random, FLAC))))
      expect(ms).toBeLessThan(2000)
    })
  })

  it('refuse random bytes and bytes that begin like a FLAC file', async () => {
    await eachSeed(300, (random) => {
      decodesOrRefuses(randomBytes(random, int(random, 300)))
      decodesOrRefuses(Uint8Array.from([0x66, 0x4c, 0x61, 0x43, ...randomBytes(random, int(random, 400))]))
      decodesOrRefuses(Uint8Array.from([...FLAC.subarray(0, 4 + 4 + 34), ...randomBytes(random, int(random, 400))]))
    })
  })

  it('read the metadata of damaged files without throwing anything but a decode error', async () => {
    await eachSeed(400, (random) => {
      try {
        const meta = parseFlacMetadata(mutateBytes(random, FLAC.subarray(0, 600)))
        expect(meta.info.sampleRate).toBeGreaterThanOrEqual(0)
      } catch (error) {
        onlyDecodeErrors(error)
      }
    })
  })

  it('do not allocate for a stream that claims a length it does not have', () => {
    for (const total of [0xffffffff, 0x7fffffff]) {
      const bytes = Uint8Array.from(FLAC)
      // STREAMINFO: after "fLaC" and the 4-byte block header, bytes 10..17 hold sample rate, channels, bits and 36 bits of length
      for (let i = 0; i < 4; i++) bytes[4 + 4 + 14 + i] = (total >>> (8 * (3 - i))) & 0xff
      const { ms } = timed(() => decodesOrRefuses(bytes))
      expect(ms).toBeLessThan(2000)
    }
  })
})
