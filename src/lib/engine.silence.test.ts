import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AudioEngine, silenceAudio } from './engine'

// When the page has failed, the sound has to stop and stay stopped: the recovery screen cannot control a player that is gone from
// the screen, and the player's pending work (a file that was still being checked or decoded) would otherwise start itself a moment later.

type Session = { metadata: unknown; playbackState: string }

function fakeMediaSession(session: Session): void {
  Object.defineProperty(navigator, 'mediaSession', { configurable: true, value: session })
}

beforeEach(() => {
  // jsdom has no media playback; every element an engine made in this file is paused by each call, so stub it for all of them
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  Reflect.deleteProperty(navigator, 'mediaSession')
})

describe('silenceAudio', () => {
  it('pauses both decks', () => {
    const engine = new AudioEngine()
    const pauses = engine.decks.map((deck) => vi.spyOn(deck.el, 'pause'))
    silenceAudio()
    for (const pause of pauses) expect(pause).toHaveBeenCalled()
  })

  it('does not let a track that starts afterwards play: only a reload brings the sound back', async () => {
    const engine = new AudioEngine()
    silenceAudio()
    for (const deck of engine.decks) await expect(deck.el.play()).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('reaches the elements of every engine that was made', async () => {
    const first = new AudioEngine()
    const second = new AudioEngine()
    silenceAudio()
    for (const deck of [...first.decks, ...second.decks]) await expect(deck.el.play()).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('takes the player off the lock screen and the notification shade', () => {
    const session: Session = { metadata: { title: 'Night Train' }, playbackState: 'playing' }
    fakeMediaSession(session)
    silenceAudio()
    expect(session.metadata).toBeNull()
    expect(session.playbackState).toBe('none')
  })

  it('copes with a media session that refuses, and with a browser that has none', () => {
    fakeMediaSession({
      get metadata() {
        return null
      },
      set metadata(_value: unknown) {
        throw new TypeError('refused')
      },
      playbackState: 'playing',
    })
    expect(() => silenceAudio()).not.toThrow()
    Reflect.deleteProperty(navigator, 'mediaSession')
    expect(() => silenceAudio()).not.toThrow()
  })

  it('may be called again', () => {
    new AudioEngine()
    expect(() => {
      silenceAudio()
      silenceAudio()
    }).not.toThrow()
  })
})
