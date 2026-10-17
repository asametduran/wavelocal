import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { BackLayers } from './backlayer'

const isLayerEntry = (state: unknown): boolean => typeof state === 'object' && state !== null && 'wlLayer' in state

/**
 * jsdom walks the session history a moment after `back()` / `go()`, in more than one hop of its timers, so nothing here
 * sleeps for a guessed time: a test waits for what it expects to happen (and a test that expects nothing to happen looks
 * at a moment that has certainly passed, because the work it is about is done in microtasks).
 */
const until = (check: () => void) => vi.waitFor(check, { timeout: 3_000, interval: 5 })

describe('BackLayers', () => {
  let frame: HTMLIFrameElement
  let win: Window
  let layers: BackLayers
  let others: Mock<(e: Event) => void>

  beforeEach(() => {
    // a window of its own for every test (an iframe has its own session history), so that a history change one test left
    // under way can never land in the next
    frame = document.createElement('iframe')
    document.body.append(frame)
    win = frame.contentWindow as Window
    win.history.replaceState(null, '')
    // the layers listen first, as they do in the app (they are made at start-up); a listener of the page itself, such as the
    // one that closes sheets on Back, comes after them
    layers = new BackLayers(win)
    others = vi.fn<(e: Event) => void>()
    win.addEventListener('popstate', others)
  })

  afterEach(() => {
    layers.dispose()
    frame.remove()
  })

  it('adds one history entry while a layer is open', () => {
    const push = vi.spyOn(win.history, 'pushState')
    layers.open(() => {})
    expect(push).toHaveBeenCalledTimes(1)
    expect(isLayerEntry(win.history.state)).toBe(true)
  })

  it('keeps what the current history entry already remembers, so landing on it again changes nothing for the page', () => {
    win.history.replaceState({ wlTrail: ['album:x'] }, '')
    layers.open(() => {})
    expect(win.history.state).toMatchObject({ wlTrail: ['album:x'] })
  })

  it('takes its entry away again when the layer is closed, and nobody else mistakes that for a Back press', async () => {
    const close = layers.open(() => {})
    close()
    await until(() => expect(win.history.state).toBeNull())
    expect(others).not.toHaveBeenCalled()
  })

  it('tells the layer about Back, once, and keeps the page’s own listeners out of it', async () => {
    const onBack = vi.fn()
    layers.open(onBack)
    win.history.back()
    await until(() => expect(onBack).toHaveBeenCalledTimes(1))
    expect(win.history.state).toBeNull()
    expect(others).not.toHaveBeenCalled()
  })

  it('does not take its entry away a second time when the layer was closed by Back and then cleans up', async () => {
    const go = vi.spyOn(win.history, 'go')
    const onBack = vi.fn()
    const close = layers.open(onBack)
    win.history.back()
    await until(() => expect(onBack).toHaveBeenCalledTimes(1))
    close() // the component's cleanup, after the layer already answered Back
    await Promise.resolve() // what a close would do (the history change it asks for) is asked for in a microtask
    await Promise.resolve()
    expect(go).not.toHaveBeenCalled()
    expect(others).not.toHaveBeenCalled()
  })

  it('leaves Back alone when no layer is open', async () => {
    win.history.pushState({ page: 1 }, '')
    win.history.back()
    await until(() => expect(others).toHaveBeenCalledTimes(1))
  })

  it('hands Back to the layer on top first, then to the one under it', async () => {
    const order: string[] = []
    layers.open(() => order.push('under'))
    layers.open(() => order.push('top'))
    win.history.back()
    await until(() => expect(order).toEqual(['top']))
    win.history.back()
    await until(() => expect(order).toEqual(['top', 'under']))
    expect(others).not.toHaveBeenCalled()
  })

  it('lets a layer that closes while another waits keep the entry, with no history traffic at all', async () => {
    const push = vi.spyOn(win.history, 'pushState')
    const go = vi.spyOn(win.history, 'go')
    const closeFirst = layers.open(() => {})
    closeFirst()
    layers.open(() => {}) // the next question, in the same breath
    await Promise.resolve() // the microtask in which a leftover entry would be taken away has run
    await Promise.resolve()
    expect(push).toHaveBeenCalledTimes(1)
    expect(go).not.toHaveBeenCalled()
    expect(isLayerEntry(win.history.state)).toBe(true)
  })

  it('waits for an entry that is being taken away before adding the next, so the two cannot cross', async () => {
    const push = vi.spyOn(win.history, 'pushState')
    const onBack = vi.fn()
    const closeFirst = layers.open(() => {})
    closeFirst()
    await Promise.resolve() // the entry is on its way out…
    layers.open(onBack) // …when the next layer opens
    expect(push).toHaveBeenCalledTimes(1)
    await until(() => expect(push).toHaveBeenCalledTimes(2)) // it has gone: now the new layer gets its own
    expect(isLayerEntry(win.history.state)).toBe(true)

    win.history.back()
    await until(() => expect(onBack).toHaveBeenCalledTimes(1))
    expect(others).not.toHaveBeenCalled()
  })

  it('does nothing when a layer is closed twice', async () => {
    const go = vi.spyOn(win.history, 'go')
    const close = layers.open(() => {})
    close()
    close()
    await until(() => expect(win.history.state).toBeNull())
    expect(go).toHaveBeenCalledTimes(1)
  })

  it('gives a new layer its entry again after Back answered the one before', async () => {
    const first = vi.fn()
    layers.open(first)
    win.history.back()
    await until(() => expect(first).toHaveBeenCalledTimes(1))
    const onBack = vi.fn()
    layers.open(onBack)
    expect(isLayerEntry(win.history.state)).toBe(true)
    win.history.back()
    await until(() => expect(onBack).toHaveBeenCalledTimes(1))
  })

  it('does not wait for ever for a history that never answers', async () => {
    vi.useFakeTimers()
    try {
      vi.spyOn(win.history, 'go').mockImplementation(() => {}) // a browser that ignores the request
      const push = vi.spyOn(win.history, 'pushState')
      const closeFirst = layers.open(() => {})
      closeFirst()
      await Promise.resolve()
      layers.open(() => {})
      expect(push).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(2_000)
      expect(push).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('still works as a dialog when the browser refuses to add a history entry', async () => {
    vi.spyOn(win.history, 'pushState').mockImplementation(() => {
      throw new DOMException('too many calls', 'SecurityError')
    })
    const close = layers.open(() => {})
    expect(() => close()).not.toThrow()
    await Promise.resolve()
  })

  it('stops listening once it is disposed', async () => {
    const onBack = vi.fn()
    layers.open(onBack)
    layers.dispose()
    win.history.back()
    await until(() => expect(others).toHaveBeenCalledTimes(1))
    expect(onBack).not.toHaveBeenCalled()
  })
})
