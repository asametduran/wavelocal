// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { Value } from './value'

describe('Value', () => {
  it('holds what it was given and hands out what was set', () => {
    const value = new Value<number | null>(null)
    expect(value.get()).toBeNull()
    value.set(12.5)
    expect(value.get()).toBe(12.5)
  })

  it('tells each listener once for each change, and not at all for a change to the same value', () => {
    const value = new Value(1)
    const heard = vi.fn()
    value.subscribe(heard)
    value.set(2)
    value.set(2)
    value.set(3)
    expect(heard).toHaveBeenCalledTimes(2)
    value.set(Number.NaN)
    value.set(Number.NaN) // NaN is the same value as NaN here, not a change every time
    expect(heard).toHaveBeenCalledTimes(3)
  })

  it('stops telling a listener that unsubscribed, and tells the others', () => {
    const value = new Value('a')
    const first = vi.fn()
    const second = vi.fn()
    const stop = value.subscribe(first)
    value.subscribe(second)
    stop()
    stop() // unsubscribing twice is harmless
    value.set('b')
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('lets a listener unsubscribe, or subscribe another, while it is being told', () => {
    const value = new Value(0)
    const late = vi.fn()
    let stop = (): void => {}
    stop = value.subscribe(() => {
      stop()
      value.subscribe(late)
    })
    expect(() => value.set(1)).not.toThrow()
    expect(late).not.toHaveBeenCalled() // it was added during the change, so it hears the next one
    value.set(2)
    expect(late).toHaveBeenCalledTimes(1)
  })

  it('can be handed to something that calls the functions loose, the way React does', () => {
    const value = new Value(1)
    const { get, set, subscribe } = value
    const heard = vi.fn()
    subscribe(heard)
    set(5)
    expect(get()).toBe(5)
    expect(heard).toHaveBeenCalledTimes(1)
  })
})
