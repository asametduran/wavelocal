import { Component, lazy, Suspense, useEffect, useState } from 'react'
import type { ComponentType, ErrorInfo, ReactNode } from 'react'

/** A dynamic `import()` of a module whose default export is a component. */
export type Loader<P extends object> = () => Promise<{ default: ComponentType<P> }>

interface BoundaryState {
  failed: boolean
}

/**
 * Catches a failed chunk download (offline before the panel was ever cached) so one missing panel cannot blank the
 * whole app. Offers a retry instead of failing silently.
 */
class ChunkBoundary extends Component<{ children: ReactNode; label: string; onDismiss?: () => void }, BoundaryState> {
  state: BoundaryState = { failed: false }

  static getDerivedStateFromError(): BoundaryState {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.warn(`Could not load ${this.props.label}`, error, info.componentStack)
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children
    return (
      <div role="alert" className="fixed inset-x-0 bottom-24 z-[90] mx-auto flex w-fit max-w-[90vw] items-center gap-3 rounded-full bg-raised px-5 py-2.5 text-sm shadow-lg ring-1 ring-white/10">
        <span>Could not load {this.props.label}. Check your connection.</span>
        <button
          type="button"
          className="font-semibold text-accent"
          onClick={() => {
            this.setState({ failed: false })
            this.props.onDismiss?.()
          }}
        >
          Dismiss
        </button>
      </div>
    )
  }
}

/** Suspense + failure containment for one lazily loaded piece of UI. Renders nothing while the chunk loads. */
export function Deferred({ label, children, onDismiss }: { label: string; children: ReactNode; onDismiss?: () => void }) {
  return (
    <ChunkBoundary label={label} onDismiss={onDismiss}>
      <Suspense fallback={null}>{children}</Suspense>
    </ChunkBoundary>
  )
}

/** A lazily loaded component whose failed download can be forgotten with `reset()`. */
export type RetryableLazy<P extends object> = ComponentType<P> & { reset: () => void }

/**
 * `React.lazy` that can recover: React remembers a failed import forever, so after a failure (offline, flaky network)
 * the caller calls `reset()` (the failure notice's Dismiss) and the next mount downloads the chunk again instead of
 * failing until the page is reloaded. Resetting while a failure is still on screen would loop, so it is explicit.
 */
export function lazyRetry<P extends object>(load: Loader<P>): RetryableLazy<P> {
  let Inner = lazy(load)
  const Component = (props: P) => <Inner {...(props as React.JSX.IntrinsicAttributes & P)} />
  return Object.assign(Component, {
    reset: () => {
      Inner = lazy(load)
    },
  })
}

/**
 * A dialog/panel whose code is only downloaded once it is first opened (`open` becomes true).
 * `onClose` doubles as the "dismiss" action of the load-failure notice, which also unmounts the panel so that
 * opening it again starts a new download.
 */
export function lazyPanel<P extends { open: boolean; onClose: () => void }>(label: string, load: Loader<P>): ComponentType<P> {
  const Panel = lazyRetry(load)
  return function LazyPanel(props: P) {
    const [wanted, setWanted] = useState(props.open)
    useEffect(() => {
      if (props.open) setWanted(true)
    }, [props.open])
    if (!wanted) return null
    return (
      <Deferred
        label={label}
        onDismiss={() => {
          Panel.reset()
          setWanted(false)
          props.onClose()
        }}
      >
        <Panel {...props} />
      </Deferred>
    )
  }
}

/**
 * Warm the browser (and service-worker) cache for panels the user is likely to open, once the app is idle, so the
 * first open is instant without those bytes competing with startup.
 */
export function preloadWhenIdle(loaders: readonly (() => Promise<unknown>)[]): () => void {
  const run = () => loaders.forEach((load) => void load().catch(() => {}))
  if (typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(run, { timeout: 4000 })
    return () => window.cancelIdleCallback(id)
  }
  const id = window.setTimeout(run, 2000)
  return () => window.clearTimeout(id)
}
