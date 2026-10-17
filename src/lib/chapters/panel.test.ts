// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { OpenSwitch } from './panel'

describe('OpenSwitch', () => {
  it('starts closed, opens, closes and toggles', () => {
    const panel = new OpenSwitch()
    expect(panel.get()).toBe(false)
    panel.set(true)
    expect(panel.get()).toBe(true)
    panel.toggle()
    expect(panel.get()).toBe(false)
    panel.toggle()
    expect(panel.get()).toBe(true)
  })

  it('tells those who listen when it changes, and only then', () => {
    const panel = new OpenSwitch()
    const heard = vi.fn()
    panel.subscribe(heard)
    panel.set(false) // already closed
    expect(heard).not.toHaveBeenCalled()
    panel.set(true)
    panel.set(true)
    expect(heard).toHaveBeenCalledTimes(1)
    panel.toggle()
    expect(heard).toHaveBeenCalledTimes(2)
  })

  it('stops telling those who stopped listening', () => {
    const panel = new OpenSwitch()
    const heard = vi.fn()
    const stop = panel.subscribe(heard)
    stop()
    panel.set(true)
    expect(heard).not.toHaveBeenCalled()
  })

  it('lets a listener stop listening while it is being told', () => {
    const panel = new OpenSwitch()
    const second = vi.fn()
    const stop = panel.subscribe(() => stop())
    panel.subscribe(second)
    expect(() => panel.set(true)).not.toThrow()
    expect(second).toHaveBeenCalledTimes(1)
  })
})
