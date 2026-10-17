// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { LONG_RECORDING, isLongRecording, showTools } from './extras'

const song = { always: false, chapters: 0, looping: false, bookmarks: 0, long: false }

describe('showTools', () => {
  it('leaves a song as it always looked: no row of loop and bookmark buttons under the seek bar', () => {
    expect(showTools(song)).toBe(false)
  })

  it('shows the row when the person asked for it to be there for every track', () => {
    expect(showTools({ ...song, always: true })).toBe(true)
  })

  it('shows the row for a recording that has chapters', () => {
    expect(showTools({ ...song, chapters: 1 })).toBe(true)
  })

  it('shows the row while a loop is set or waiting for its end, so there is a way to see and clear it', () => {
    expect(showTools({ ...song, looping: true })).toBe(true)
  })

  it('shows the row for a track that has bookmarks, so they can be reached', () => {
    expect(showTools({ ...song, bookmarks: 1 })).toBe(true)
  })

  it('shows the row for a long recording, which is what the buttons are for', () => {
    expect(showTools({ ...song, long: true })).toBe(true)
  })
})

describe('isLongRecording', () => {
  it('is true from twenty minutes on, and not a second before', () => {
    expect(LONG_RECORDING).toBe(20 * 60)
    expect(isLongRecording(LONG_RECORDING)).toBe(true)
    expect(isLongRecording(LONG_RECORDING + 3600)).toBe(true)
    expect(isLongRecording(LONG_RECORDING - 1)).toBe(false)
    expect(isLongRecording(215)).toBe(false) // a song
  })

  it('is false for a length that is not known or not a time', () => {
    for (const length of [0, -5, Number.NaN, Number.NEGATIVE_INFINITY]) expect(isLongRecording(length), String(length)).toBe(false)
  })

  it('does not take an infinite length (a stream without an end) for a long recording to keep', () => {
    expect(isLongRecording(Number.POSITIVE_INFINITY)).toBe(false)
  })
})
