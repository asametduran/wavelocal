import { act, lazy } from 'react'
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Deferred } from './lazy'

const mocks = vi.hoisted(() => ({ keep: vi.fn() }))
vi.mock('../lib/diagnostics/capture', () => ({ keep: mocks.keep }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function Thrower({ error }: { error: Error }): ReactNode {
  throw error
}

let container: HTMLElement
let root: Root

beforeEach(() => {
  mocks.keep.mockReset()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  vi.spyOn(console, 'error').mockImplementation(() => {}) // React reports a caught render error, which is what these tests cause
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

const alert = (): string => container.querySelector('[role="alert"]')?.textContent ?? ''

function mountFailing(error: Error, onDismiss?: () => void): void {
  act(() =>
    root.render(
      <Deferred label="the shortcut list" onDismiss={onDismiss}>
        <Thrower error={error} />
      </Deferred>,
    ),
  )
}

/** What the browsers throw when a dynamic import cannot fetch its file. */
const DOWNLOADS: readonly [string, Error][] = [
  ['Chromium', new TypeError('Failed to fetch dynamically imported module: https://example.test/assets/Shortcuts-abc.js')],
  ['Firefox', new TypeError('error loading dynamically imported module')],
  ['Safari', new TypeError('Importing a module script failed.')],
  ['a bundler that names it', Object.assign(new Error('The server did not answer.'), { name: 'ChunkLoadError' })], // only its name says what it is
  ['a bundler that words it', new Error('Loading chunk 7 failed.')],
]

describe('Deferred: a lazy panel that cannot be shown', () => {
  it.each(DOWNLOADS)('blames the connection when %s could not download the code', (_browser, error) => {
    mountFailing(error)
    expect(alert()).toContain('Could not load the shortcut list. Check your connection.')
  })

  it('does not blame the connection when the code arrived and then failed', () => {
    mountFailing(new TypeError("Cannot read properties of undefined (reading 'map')"))
    expect(alert()).toContain('Something went wrong in the shortcut list.')
    expect(alert()).not.toContain('connection')
  })

  it('keeps either failure in the error log, as a boundary entry', () => {
    const bug = new RangeError('Invalid array length')
    mountFailing(bug)
    expect(mocks.keep).toHaveBeenCalledWith('boundary', bug)
    act(() => root.unmount())
    root = createRoot(container)
    mocks.keep.mockReset()
    const download = new TypeError('Failed to fetch dynamically imported module: https://example.test/x.js')
    mountFailing(download)
    expect(mocks.keep).toHaveBeenCalledWith('boundary', download)
  })

  it('clears the notice and tells the owner when it is dismissed', () => {
    // the owner takes the panel away (or makes it work again) in `onDismiss`; a panel that still failed would be caught again
    let broken = true
    const onDismiss = vi.fn(() => void (broken = false))
    function Panel(): ReactNode {
      if (broken) throw new Error('boom')
      return <p>the panel</p>
    }
    act(() =>
      root.render(
        <Deferred label="the shortcut list" onDismiss={onDismiss}>
          <Panel />
        </Deferred>,
      ),
    )
    expect(alert()).toContain('Something went wrong')
    const dismiss = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Dismiss')
    expect(dismiss).toBeDefined()
    act(() => dismiss?.click())
    expect(onDismiss).toHaveBeenCalledTimes(1)
    expect(alert()).toBe('')
    expect(container.textContent).toBe('the panel')
  })

  it('shows its children when nothing is wrong, and does not raise an alert', () => {
    act(() =>
      root.render(
        <Deferred label="the shortcut list">
          <p>shortcuts</p>
        </Deferred>,
      ),
    )
    expect(container.textContent).toBe('shortcuts')
    expect(alert()).toBe('')
    expect(mocks.keep).not.toHaveBeenCalled()
  })
})

describe('Deferred: a panel that is still on its way', () => {
  it('renders nothing until it arrives, and then the panel', async () => {
    let arrive: (module: { default: () => ReactNode }) => void = () => {}
    const Late = lazy(() => new Promise<{ default: () => ReactNode }>((resolve) => void (arrive = resolve)))
    act(() =>
      root.render(
        <Deferred label="the lyrics">
          <Late />
        </Deferred>,
      ),
    )
    expect(container.textContent).toBe('')
    await act(async () => arrive({ default: () => <p>the words</p> }))
    expect(container.textContent).toBe('the words')
  })

  it('holds the place it was given while it loads, so that the page does not jump', async () => {
    let arrive: (module: { default: () => ReactNode }) => void = () => {}
    const Late = lazy(() => new Promise<{ default: () => ReactNode }>((resolve) => void (arrive = resolve)))
    act(() =>
      root.render(
        <Deferred label="the visualizer" fallback={<div data-testid="place" className="h-16" />}>
          <Late />
        </Deferred>,
      ),
    )
    expect(container.querySelector('[data-testid="place"]')).not.toBeNull()
    await act(async () => arrive({ default: () => <canvas /> }))
    expect(container.querySelector('[data-testid="place"]')).toBeNull()
    expect(container.querySelector('canvas')).not.toBeNull()
  })
})
