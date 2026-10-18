import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { keep, loadLog } from '../lib/diagnostics/capture'
import { silenceAudio } from '../lib/engine'
import { startFresh } from '../lib/safestart'

/**
 * The last safety net: when the page cannot go on (a render error that no panel's own boundary caught), this is all that is left on
 * screen. It is written to need nothing that could be the problem: plain elements and classes the stylesheet already has, no icons,
 * no dialogs, no lazy panel, no player, no database. What it offers is a reload, a fresh start that keeps the music and the playlists
 * and forgets the settings, where you were and the queue (the likeliest causes of a crash on every start), and the details of what
 * happened for whoever is helping, cleaned of names the way the Diagnostics section does it.
 */

export interface RecoveryPorts {
  reload: () => void
  startFresh: () => void
  /** The cleaned text of what happened, for the person to copy. */
  details: (error: unknown) => Promise<string>
  /** Put the text on the clipboard; rejects where the browser will not. */
  copy: (text: string) => Promise<void>
}

/** What is said when the log, which is a download of its own, cannot be fetched: the name of the error and nothing else. */
const bare = (error: unknown): string => {
  const name = error instanceof Error && /^[A-Za-z][\w.$-]{0,59}$/.test(error.name) ? error.name : 'Error'
  return `Wavelocal error report\n${name}\nThe log could not be loaded, so nothing else is included.`
}

const defaults: RecoveryPorts = {
  reload: () => location.reload(),
  startFresh: () => startFresh(() => location.reload()),
  details: async (error) => {
    try {
      // `keep` handed this error to the log before this runs, and the log is one download: by now it has been recorded
      const [{ diagnostics }, { appBuild, buildReport, describeBrowser }] = await Promise.all([loadLog(), import('../lib/diagnostics/report')])
      return buildReport(diagnostics.snapshot(), { build: appBuild(), browser: describeBrowser(navigator.userAgent), now: Date.now() })
    } catch {
      return bare(error)
    }
  },
  copy: (text) => navigator.clipboard.writeText(text),
}

interface Props {
  children: ReactNode
  ports?: Partial<RecoveryPorts>
}

interface State {
  failed: boolean
  /** "Start fresh" has been asked for once and is waiting for the second ask, which says what it does. */
  asking: boolean
  /** The details, shown to select and copy by hand when the browser would not put them on the clipboard. */
  details: string | null
}

const button = 'rounded-full bg-white/10 px-5 py-3 text-sm font-semibold text-zinc-100 transition hover:bg-white/15'
const primary = 'rounded-full bg-accent px-5 py-3 text-sm font-semibold text-on-accent transition hover:opacity-90'

export default class RootBoundary extends Component<Props, State> {
  state: State = { failed: false, asking: false, details: null }
  private error: unknown = null

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true }
  }

  componentDidCatch(error: Error, _info: ErrorInfo): void {
    this.error = error
    silenceAudio() // the player is gone from the screen, and its sound must go with it
    keep('boundary', error)
  }

  private get ports(): RecoveryPorts {
    return { ...defaults, ...this.props.ports }
  }

  private copy = async (): Promise<void> => {
    let text = bare(this.error)
    try {
      text = await this.ports.details(this.error)
    } catch {
      // the bare report stands: the name of the error is better than nothing
    }
    try {
      await this.ports.copy(text)
      this.setState({ details: null })
    } catch {
      this.setState({ details: text })
    }
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children
    const { asking, details } = this.state
    return (
      <main className="fixed inset-0 z-[100] grid place-items-center overflow-y-auto bg-base p-4 text-zinc-100">
        <div className="w-full max-w-md rounded-3xl bg-panel p-6 shadow-2xl">
          <div role="alert">
            <h1 className="text-lg font-bold">Wavelocal stopped working</h1>
            <p className="mt-2 text-sm text-zinc-300">Something went wrong and the page could not go on. Your music and playlists are safe on this device. Reloading usually puts it right.</p>
          </div>
          <div className="mt-5 flex flex-col gap-2">
            <button type="button" autoFocus className={primary} onClick={() => this.ports.reload()}>
              Reload
            </button>
            {asking ? (
              <div className="rounded-2xl bg-white/5 p-3">
                <p className="text-sm text-zinc-300">Start fresh keeps your music and playlists. It forgets your settings, where you were and what was queued, and then reloads.</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button type="button" className={primary} onClick={() => this.ports.startFresh()}>
                    Start fresh
                  </button>
                  <button type="button" className={button} onClick={() => this.setState({ asking: false })}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button type="button" className={button} onClick={() => this.setState({ asking: true })}>
                Start fresh…
              </button>
            )}
            <button type="button" className={button} onClick={() => void this.copy()}>
              Copy details
            </button>
            {details !== null && <textarea readOnly aria-label="Details" value={details} onFocus={(event) => event.currentTarget.select()} className="h-40 w-full rounded-xl bg-black/30 p-3 font-mono text-xs text-zinc-200" />}
          </div>
        </div>
      </main>
    )
  }
}
