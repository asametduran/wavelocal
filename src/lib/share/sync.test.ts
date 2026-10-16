import { describe, expect, it } from 'vitest'
import { CORRECTION_COOLDOWN_MS, DRIFT_SEEK_SECONDS, HEARTBEAT_MS, TOGGLE_COOLDOWN_MS, broadcastReason, planGuest, predictedPosition, targetPosition } from './sync'
import type { Announcement, GuestTiming, GuestView, HostState } from './sync'

const last = (over: Partial<Announcement> = {}): Announcement => ({ key: 'a', playing: true, position: 10, speed: 1, at: 1000, ...over })

describe('predictedPosition', () => {
  it('advances while playing, scaled by speed', () => {
    expect(predictedPosition(last(), 3000)).toBeCloseTo(12)
    expect(predictedPosition(last({ speed: 1.5 }), 3000)).toBeCloseTo(13)
  })
  it('stands still while paused', () => {
    expect(predictedPosition(last({ playing: false }), 9000)).toBe(10)
  })
})

describe('broadcastReason', () => {
  const cur = (over = {}) => ({ key: 'a', playing: true, position: 11, speed: 1, ...over })

  it('announces the very first state', () => {
    expect(broadcastReason(null, cur(), 2000)).toBe('track')
  })
  it('stays quiet while playback goes exactly as predicted', () => {
    expect(broadcastReason(last(), cur({ position: 10.4 }), 1400)).toBeNull()
  })
  it('reports track, play/pause and speed changes immediately', () => {
    expect(broadcastReason(last(), cur({ key: 'b' }), 1100)).toBe('track')
    expect(broadcastReason(last(), cur({ key: null }), 1100)).toBe('track')
    expect(broadcastReason(last(), cur({ playing: false }), 1100)).toBe('playing')
    expect(broadcastReason(last(), cur({ speed: 1.25 }), 1100)).toBe('speed')
  })
  it('reports a seek in either direction but not ordinary timer jitter', () => {
    expect(broadcastReason(last(), cur({ position: 60 }), 1500)).toBe('seek')
    expect(broadcastReason(last(), cur({ position: 2 }), 1500)).toBe('seek')
    expect(broadcastReason(last(), cur({ position: 10.9 }), 1500)).toBeNull()
  })
  it('sends a heartbeat so a late joiner or a drifting guest recovers', () => {
    expect(broadcastReason(last(), cur({ position: 10 + HEARTBEAT_MS / 1000 }), 1000 + HEARTBEAT_MS)).toBe('heartbeat')
    expect(broadcastReason(last({ playing: false }), cur({ playing: false, position: 10 }), 1000 + HEARTBEAT_MS)).toBe('heartbeat')
  })
})

describe('targetPosition', () => {
  const host: HostState = { playing: true, position: 30, speed: 1, at: 50_000 }

  it('accounts for the clock offset and the time since the announcement', () => {
    // host clock is 1000 ms ahead of ours, so local 49_500 is host 50_500: half a second after the announcement
    expect(targetPosition(host, 1000, 49_500, 200)).toBeCloseTo(30.5)
  })
  it('does not run backwards if the estimate puts "now" before the announcement', () => {
    expect(targetPosition(host, 0, 49_000, 200)).toBe(30)
  })
  it('does not advance while paused', () => {
    expect(targetPosition({ ...host, playing: false }, 0, 99_000, 200)).toBe(30)
  })
  it('stays inside the track', () => {
    expect(targetPosition(host, 0, 500_000, 100)).toBe(100)
    expect(targetPosition({ ...host, position: 0 }, 0, 50_000, 0)).toBe(0)
  })
})

describe('planGuest', () => {
  const host: HostState = { playing: true, position: 30, speed: 1, at: 50_000 }
  const view = (over: Partial<GuestView> = {}): GuestView => ({ ready: true, playing: true, position: 31, ...over })
  const timing = (over: Partial<GuestTiming> = {}): GuestTiming => ({ now: 51_000, lastSeekAt: 0, lastToggleAt: 0, ...over })

  it('waits until the right track is loaded', () => {
    expect(planGuest(host, 0, view({ ready: false }), timing(), 200)).toEqual({ kind: 'none' })
  })
  it('leaves a guest alone when it is within the drift tolerance', () => {
    expect(planGuest(host, 0, view({ position: 31 + DRIFT_SEEK_SECONDS - 0.05 }), timing(), 200)).toEqual({ kind: 'none' })
  })
  it('pulls a drifting guest back to where the host is now', () => {
    expect(planGuest(host, 0, view({ position: 35 }), timing(), 200)).toEqual({ kind: 'seek', to: 31 })
    expect(planGuest(host, 0, view({ position: 20 }), timing(), 200)).toEqual({ kind: 'seek', to: 31 })
  })
  it('does not seek again right after a seek', () => {
    const t = timing({ lastSeekAt: 51_000 - CORRECTION_COOLDOWN_MS + 100 })
    expect(planGuest(host, 0, view({ position: 40 }), t, 200)).toEqual({ kind: 'none' })
  })
  it('follows play and pause, but not faster than the player can report', () => {
    expect(planGuest(host, 0, view({ playing: false }), timing(), 200)).toEqual({ kind: 'toggle' })
    expect(planGuest({ ...host, playing: false }, 0, view({ playing: true }), timing(), 200)).toEqual({ kind: 'toggle' })
    expect(planGuest(host, 0, view({ playing: false }), timing({ lastToggleAt: 51_000 - TOGGLE_COOLDOWN_MS + 1 }), 200)).toEqual({ kind: 'none' })
  })
  it('aligns a paused guest to the paused position', () => {
    const paused: HostState = { ...host, playing: false }
    expect(planGuest(paused, 0, view({ playing: false, position: 5 }), timing(), 200)).toEqual({ kind: 'seek', to: 30 })
  })
})
