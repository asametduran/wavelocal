/**
 * Layers the system's Back action closes: a phone's Back button, a TV remote's Back, the browser's Back. While a layer
 * (a dialog) is open it owns one entry of the browser history, so Back lands on the entry before it and the layer is told
 * to close, instead of the app being left or the sheet under it closed. Closing a layer any other way takes its entry away
 * again, so the history ends up as it was.
 *
 * Two things make that safe next to the page's other Back handling (sheets, album pages), which listens for the same
 * `popstate` events: this listens first and keeps the events that are its own away from the others, and it never starts a
 * history change while one of its own is still under way (a browser does them a moment later, and a push that crosses a
 * pending traversal would land on the wrong entry).
 *
 * "First" is a matter of when the listener is added: Chromium runs the listeners of `window` in the order they were added,
 * whatever their phase (jsdom and some other engines run capturing ones first, which is why the flag is set as well). So the
 * page's instance is made when this module is loaded, at start-up, before any sheet or page has a listener of its own.
 */

interface Layer {
  onBack: () => void
}

/** The part of `window` this needs, so that a test can hand it a window of its own. */
type Host = Pick<Window, 'history' | 'addEventListener' | 'removeEventListener'>

/** How long a history change of ours may take before the browser is taken not to be answering. */
const SETTLE_MS = 1_000

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null
const isLayerEntry = (state: unknown): boolean => isRecord(state) && 'wlLayer' in state

export class BackLayers {
  private readonly layers: Layer[] = []
  /** History entries added here and not taken away yet. */
  private entries = 0
  /** A `history.go` of ours is under way: the `popstate` it ends with is not somebody pressing Back. */
  private settling = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private seq = 0

  constructor(private readonly host: Host) {
    host.addEventListener('popstate', this.onPop, true)
  }

  /**
   * Open a layer. `onBack` is called when Back is pressed with this layer on top. Returns the function that closes the layer
   * (a layer that Back closed needs no closing, and closing twice does nothing).
   */
  open(onBack: () => void): () => void {
    const layer: Layer = { onBack }
    this.layers.push(layer)
    this.sync()
    return () => {
      const at = this.layers.indexOf(layer)
      if (at < 0) return
      this.layers.splice(at, 1)
      // a layer opened in the same breath (the next question in line) takes over the entry: nothing then needs to change
      queueMicrotask(() => this.sync())
    }
  }

  /** Stop listening and forget every layer. */
  dispose(): void {
    this.host.removeEventListener('popstate', this.onPop, true)
    clearTimeout(this.timer)
    this.layers.length = 0
    this.entries = 0
    this.settling = false
  }

  private readonly onPop = (e: PopStateEvent): void => {
    if (this.settling) {
      // the traversal this module asked for has landed
      this.settling = false
      clearTimeout(this.timer)
      e.stopImmediatePropagation()
      this.sync() // layers may have come or gone while it was under way
      return
    }
    if (this.entries === 0) return // somebody else's navigation
    this.entries--
    e.stopImmediatePropagation()
    this.layers.pop()?.onBack()
  }

  /** Make the history hold one entry for each open layer: add the ones that are missing, take away the ones that are left over. */
  private sync(): void {
    if (this.settling) return
    const { history } = this.host
    while (this.entries < this.layers.length) {
      try {
        history.pushState({ ...(isRecord(history.state) ? history.state : {}), wlLayer: ++this.seq }, '')
      } catch {
        return // the browser refuses (too many calls too fast): the layer works, only the Back button cannot reach it
      }
      this.entries++
    }
    const spare = this.entries - this.layers.length
    if (spare <= 0) return
    this.entries = this.layers.length
    if (!isLayerEntry(history.state)) return // the listener has moved off it already: there is nothing to take away
    this.settling = true
    this.timer = setTimeout(() => {
      this.settling = false
      this.sync()
    }, SETTLE_MS)
    history.go(-spare)
  }
}

/** The page's layers. Made as the module loads (see above): the code that shows dialogs is fetched later, but this is not. */
const page = typeof window === 'undefined' ? null : new BackLayers(window)

/** Open a layer on this page's own history (see `BackLayers`). */
export function openBackLayer(onBack: () => void): () => void {
  return page ? page.open(onBack) : () => {}
}
