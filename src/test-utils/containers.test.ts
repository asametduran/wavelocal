// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { buildMp3, cat, catAll } from './containers'

describe('catAll', () => {
  it('joins any number of parts, more than a function call can take as arguments', () => {
    const parts = Array.from({ length: 300_000 }, (_, i) => Uint8Array.of(i % 251))
    const joined = catAll(parts)
    expect(joined.length).toBe(300_000)
    expect([joined[0], joined[250], joined[251], joined[299_999]]).toEqual([0, 250, 0, 299_999 % 251])
  })

  it('is what cat does with its arguments, and takes plain arrays of numbers too', () => {
    expect([...cat([1, 2], Uint8Array.of(3), [])]).toEqual([1, 2, 3])
    expect([...catAll([[1, 2], Uint8Array.of(3), []])]).toEqual([1, 2, 3])
  })
})

describe('buildMp3', () => {
  it('builds a file of three hours, whose frames are more than a function call can take as arguments', () => {
    // MPEG 2.5 layer III, 8 kHz, mono, 8 kbps: 576 samples (72 ms) and exactly 72 bytes a frame
    const frames = Math.round((3 * 3600) / (576 / 8000))
    const file = buildMp3({ version: 2.5, sampleRate: 8000, bitrateKbps: 8, mode: 'mono', frames })
    expect(frames).toBe(150_000)
    expect(file.length).toBe(frames * 72)
    expect([file[0], file[1]]).toEqual([0xff, 0xe3]) // the frame sync of every frame: the file starts on one
    expect([file[(frames - 1) * 72], file[(frames - 1) * 72 + 1]]).toEqual([0xff, 0xe3]) // and the last frame is whole
  })
})
