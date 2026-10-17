import { afterEach, describe, expect, it, vi } from 'vitest'
import { overlays } from './overlays'
import { clearQueue, queueTracks } from './queueactions'
import type { Track } from '../types'

const track = (id: string, title = id): Track => ({ id, title }) as Track

afterEach(() => {
  for (const t of overlays.snapshot().toasts) overlays.dismissToast(t.id)
})

const toasts = () => overlays.snapshot().toasts

describe('queueTracks', () => {
  it('queues one track to play next, says so, and offers to take it back', () => {
    const undo = vi.fn()
    const p = { playNext: vi.fn(() => undo), addToQueue: vi.fn(() => vi.fn()) }

    queueTracks(p, 'next', [track('a', 'Help!')])

    expect(p.playNext).toHaveBeenCalledWith(['a'])
    expect(p.addToQueue).not.toHaveBeenCalled()
    expect(toasts().map((t) => t.text)).toEqual(['Playing next: Help!'])
    expect(toasts()[0]?.action?.label).toBe('Undo')
    toasts()[0]?.action?.run()
    expect(undo).toHaveBeenCalledOnce()
  })

  it('queues several tracks at the end, in the order given', () => {
    const undo = vi.fn()
    const p = { playNext: vi.fn(() => vi.fn()), addToQueue: vi.fn(() => undo) }

    queueTracks(p, 'last', [track('a'), track('b'), track('c')])

    expect(p.addToQueue).toHaveBeenCalledWith(['a', 'b', 'c'])
    expect(p.playNext).not.toHaveBeenCalled()
    expect(toasts().map((t) => t.text)).toEqual(['Added 3 tracks to the queue'])
    toasts()[0]?.action?.run()
    expect(undo).toHaveBeenCalledOnce()
  })

  it('does nothing, and says nothing, when there is nothing to queue', () => {
    const p = { playNext: vi.fn(() => vi.fn()), addToQueue: vi.fn(() => vi.fn()) }

    queueTracks(p, 'next', [])
    queueTracks(p, 'last', [])

    expect(p.playNext).not.toHaveBeenCalled()
    expect(p.addToQueue).not.toHaveBeenCalled()
    expect(toasts()).toEqual([])
  })
})

describe('clearQueue', () => {
  it('empties the queue, says how many were taken out, and offers to put them back', () => {
    const undo = vi.fn()
    const p = { upNext: [track('a'), track('b')], clearUpNext: vi.fn(() => undo) }

    clearQueue(p)

    expect(p.clearUpNext).toHaveBeenCalledOnce()
    expect(toasts().map((t) => t.text)).toEqual(['Cleared 2 queued tracks'])
    toasts()[0]?.action?.run()
    expect(undo).toHaveBeenCalledOnce()
  })

  it('leaves an empty queue alone', () => {
    const p = { upNext: [], clearUpNext: vi.fn(() => vi.fn()) }

    clearQueue(p)

    expect(p.clearUpNext).not.toHaveBeenCalled()
    expect(toasts()).toEqual([])
  })
})
