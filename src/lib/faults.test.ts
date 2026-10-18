// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { FUZZ_TIMEOUT, eachSeed, int, pick } from '../test-utils/fuzz'
import { PlaybackFaults, mediaFault } from './faults'
import type { DeckId, Failure } from './faults'

const IGNORED: Failure = { kind: 'ignore' }

describe('PlaybackFaults: which failures count', () => {
  it('reports the first failure of the source a deck was given, and says nothing about the same one again', () => {
    const faults = new PlaybackFaults()
    faults.attach(0, 'a', 'blob:a')
    expect(faults.fail(0, 'blob:a')).toEqual({ kind: 'failed', trackId: 'a', src: 'blob:a' })
    expect(faults.fail(0, 'blob:a')).toEqual(IGNORED)
    expect(faults.fail(0, 'blob:a')).toEqual(IGNORED)
  })

  it('ignores an event for a source the deck no longer has: it arrived after the player had moved on', () => {
    const faults = new PlaybackFaults()
    faults.attach(0, 'a', 'blob:a')
    faults.attach(0, 'b', 'blob:b')
    expect(faults.fail(0, 'blob:a')).toEqual(IGNORED)
    expect(faults.fail(0, 'blob:b')).toEqual({ kind: 'failed', trackId: 'b', src: 'blob:b' })
  })

  it('ignores an event for a deck that was never given a source, or has none now', () => {
    const faults = new PlaybackFaults()
    expect(faults.fail(0, 'blob:a')).toEqual(IGNORED)
    faults.attach(1, 'a', 'blob:a')
    expect(faults.fail(1, null)).toEqual(IGNORED)
    expect(faults.fail(1, '')).toEqual(IGNORED)
    expect(faults.fail(0, 'blob:a')).toEqual(IGNORED)
  })

  it('keeps the two decks apart, even when they were given the same source', () => {
    const faults = new PlaybackFaults()
    faults.attach(0, 'a', 'blob:a')
    faults.attach(1, 'a', 'blob:a')
    expect(faults.fail(1, 'blob:a')).toEqual({ kind: 'failed', trackId: 'a', src: 'blob:a' })
    expect(faults.fail(0, 'blob:a')).toEqual({ kind: 'failed', trackId: 'a', src: 'blob:a' })
    expect(faults.fail(1, 'blob:a')).toEqual(IGNORED)
  })

  it('counts a source again once it is given again: the person asked for the track again, or a decoder made a new one', () => {
    const faults = new PlaybackFaults()
    faults.attach(0, 'a', 'blob:a')
    expect(faults.fail(0, 'blob:a').kind).toBe('failed')
    faults.attach(0, 'a', 'blob:a')
    expect(faults.fail(0, 'blob:a').kind).toBe('failed')
    faults.attach(0, 'a', 'blob:decoded')
    expect(faults.fail(0, 'blob:a')).toEqual(IGNORED)
    expect(faults.fail(0, 'blob:decoded')).toEqual({ kind: 'failed', trackId: 'a', src: 'blob:decoded' })
  })

  it('forgets what a deck was given when it is emptied', () => {
    const faults = new PlaybackFaults()
    faults.attach(0, 'a', 'blob:a')
    faults.detach(0)
    expect(faults.fail(0, 'blob:a')).toEqual(IGNORED)
    expect(() => faults.detach(1)).not.toThrow()
  })

  it('does not mark a track unplayable by itself: a lossless file that the browser could not play may still be decoded', () => {
    const faults = new PlaybackFaults()
    faults.attach(0, 'a', 'blob:a')
    faults.fail(0, 'blob:a')
    expect(faults.isUnplayable('a')).toBe(false)
  })
})

describe('PlaybackFaults: tracks that cannot be played', () => {
  it('remembers the tracks it was told to give up on, and forgets one when asked', () => {
    const faults = new PlaybackFaults()
    expect(faults.isUnplayable('a')).toBe(false)
    faults.markBad('a')
    faults.markBad('a')
    faults.markBad('b')
    expect(faults.isUnplayable('a')).toBe(true)
    expect([...faults.unplayable].sort()).toEqual(['a', 'b'])
    faults.forget('a')
    expect(faults.isUnplayable('a')).toBe(false)
    expect([...faults.unplayable]).toEqual(['b'])
    expect(() => faults.forget('never seen')).not.toThrow()
  })

  it('hands out one live set, which the queue can read without asking again', () => {
    const faults = new PlaybackFaults()
    const live = faults.unplayable
    faults.markBad('a')
    expect(live.has('a')).toBe(true)
    faults.forget('a')
    expect(live.has('a')).toBe(false)
    expect(faults.unplayable).toBe(live)
  })
})

describe('PlaybackFaults: tracks that cannot be lined up in advance', () => {
  it('does not line up again a track whose preloading failed, and still lets it play when its turn comes', () => {
    const faults = new PlaybackFaults()
    expect(faults.canPreload('a')).toBe(true)
    faults.markNoPreload('a')
    expect(faults.canPreload('a')).toBe(false)
    expect(faults.isUnplayable('a')).toBe(false) // a lossless file the browser could not preload may still be decoded
    expect(faults.canPreload('b')).toBe(true)
  })

  it('does not line up a track that was given up on either', () => {
    const faults = new PlaybackFaults()
    faults.markBad('a')
    expect(faults.canPreload('a')).toBe(false)
  })

  it('lines a track up again once it is asked for by hand', () => {
    const faults = new PlaybackFaults()
    faults.markNoPreload('a')
    faults.markBad('b')
    faults.forget('a')
    faults.forget('b')
    expect(faults.canPreload('a')).toBe(true)
    expect(faults.canPreload('b')).toBe(true)
  })
})

describe('PlaybackFaults: a streak of failures', () => {
  it('counts the tracks that failed one after another, and starts again when something plays', () => {
    const faults = new PlaybackFaults()
    expect(faults.noteFailure()).toBe(1)
    expect(faults.noteFailure()).toBe(2)
    expect(faults.noteFailure()).toBe(3)
    expect(faults.progress()).toBe(3)
    expect(faults.noteFailure()).toBe(1)
  })

  it('has nothing to say about progress when nothing failed', () => {
    const faults = new PlaybackFaults()
    expect(faults.progress()).toBe(0)
    expect(faults.progress()).toBe(0)
  })

  it('is not reset by marking or forgetting tracks, only by progress', () => {
    const faults = new PlaybackFaults()
    faults.noteFailure()
    faults.markBad('a')
    faults.forget('a')
    expect(faults.noteFailure()).toBe(2)
  })
})

describe('PlaybackFaults under fuzzing', { timeout: FUZZ_TIMEOUT }, () => {
  const IDS = ['t1', 't2', 't3']
  const SRCS = ['blob:1', 'blob:2', 'blob:3']

  it('agrees with a plain model over random streams of events, however stale or repeated', async () => {
    await eachSeed(300, (random) => {
      const faults = new PlaybackFaults()
      const attempts: ({ id: string; src: string; failed: boolean } | null)[] = [null, null]
      const bad = new Set<string>()
      let streak = 0
      for (let step = 0; step < 120; step++) {
        const deck = int(random, 2) as DeckId
        switch (int(random, 7)) {
          case 0: {
            const id = pick(random, IDS)
            const src = pick(random, SRCS)
            faults.attach(deck, id, src)
            attempts[deck] = { id, src, failed: false }
            break
          }
          case 1: {
            const src = random() < 0.15 ? null : pick(random, SRCS)
            const attempt = attempts[deck]
            const expected: Failure =
              attempt && src !== null && attempt.src === src && !attempt.failed ? { kind: 'failed', trackId: attempt.id, src } : IGNORED
            if (attempt && expected.kind === 'failed') attempt.failed = true
            expect(faults.fail(deck, src)).toEqual(expected)
            break
          }
          case 2: {
            const id = pick(random, IDS)
            faults.markBad(id)
            bad.add(id)
            break
          }
          case 3: {
            const id = pick(random, IDS)
            faults.forget(id)
            bad.delete(id)
            break
          }
          case 4:
            expect(faults.noteFailure()).toBe(++streak)
            break
          case 5: {
            expect(faults.progress()).toBe(streak)
            streak = 0
            break
          }
          default:
            faults.detach(deck)
            attempts[deck] = null
        }
        expect([...faults.unplayable].sort()).toEqual([...bad].sort())
        for (const id of IDS) expect(faults.isUnplayable(id)).toBe(bad.has(id))
      }
    })
  })

  it('reports a given source at most once between two attaches, whatever order the events come in', async () => {
    await eachSeed(200, (random) => {
      const faults = new PlaybackFaults()
      let reports = 0
      let attaches = 0
      for (let step = 0; step < 100; step++) {
        if (random() < 0.25) {
          faults.attach(0, 'a', 'blob:a')
          attaches++
        } else if (faults.fail(0, 'blob:a').kind === 'failed') reports++
      }
      expect(reports).toBeLessThanOrEqual(attaches)
    })
  })
})

describe('mediaFault: what the error log keeps of a media element error', () => {
  it('names the error and its code, then what the browser said', () => {
    expect(mediaFault({ code: 4, message: 'MEDIA_ELEMENT_ERROR: Format error' })).toEqual({ name: 'MediaError', message: 'Media error 4: MEDIA_ELEMENT_ERROR: Format error' })
  })

  it('is only the code when the browser said nothing', () => {
    expect(mediaFault({ code: 3 })).toEqual({ name: 'MediaError', message: 'Media error 3' })
    expect(mediaFault({ code: 3, message: '' })).toEqual({ name: 'MediaError', message: 'Media error 3' })
    expect(mediaFault({ code: 3, message: '  \n ' })).toEqual({ name: 'MediaError', message: 'Media error 3' })
  })

  it('is code 0 when the element has no error, or a code that is not a whole number', () => {
    expect(mediaFault(null)).toEqual({ name: 'MediaError', message: 'Media error 0' })
    expect(mediaFault({ code: Number.NaN })).toEqual({ name: 'MediaError', message: 'Media error 0' })
    expect(mediaFault({ code: 2.5 })).toEqual({ name: 'MediaError', message: 'Media error 0' })
  })
})
