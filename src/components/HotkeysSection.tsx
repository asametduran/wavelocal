import { useCallback, useEffect, useMemo, useState } from 'react'
import { Keyboard } from 'lucide-react'
import { getDesktopBridge, DESKTOP_COMMANDS } from '../desktop-bridge'
import type { DesktopCommand, HotkeyResult, HotkeyState } from '../desktop-bridge'
import { COMMAND_LABELS, captureAccelerator, displayAccelerator } from '../lib/hotkey-capture'

const button = 'rounded-full bg-white/10 px-3 py-1.5 text-sm font-semibold text-zinc-200 transition hover:bg-white/15 disabled:opacity-40'

interface Notice {
  readonly tone: 'error' | 'info'
  readonly text: string
}

/**
 * Global media hotkeys (desktop app only). Each command can be recorded, cleared or reset; the shell checks every change
 * and says why one is refused. In a browser or on Android there is no bridge and this renders nothing.
 */
export default function HotkeysSection() {
  const bridge = useMemo(() => getDesktopBridge(), [])
  const hotkeys = bridge?.hotkeys
  const platform = bridge?.platform ?? 'win32'
  const [state, setState] = useState<HotkeyState | null>(null)
  const [recording, setRecording] = useState<DesktopCommand | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)

  useEffect(() => {
    let alive = true
    hotkeys
      ?.get()
      .then((s) => alive && setState(s))
      .catch(() => alive && setNotice({ tone: 'error', text: 'Global hotkeys are not available on this system.' }))
    return () => {
      alive = false
    }
  }, [hotkeys])

  const apply = useCallback((promise: Promise<HotkeyResult | HotkeyState>) => {
    promise
      .then((result) => {
        if ('ok' in result) {
          setState(result.state)
          setNotice(result.ok ? null : { tone: 'error', text: result.message })
        } else {
          setState(result)
          setNotice(null)
        }
      })
      .catch(() => setNotice({ tone: 'error', text: 'The shortcut could not be changed.' }))
  }, [])

  useEffect(() => {
    if (!recording || !hotkeys) return
    const onKey = (event: KeyboardEvent) => {
      // while recording, nothing else in the page may react to the key
      event.preventDefault()
      event.stopPropagation()
      const capture = captureAccelerator(event, platform)
      if (capture.kind === 'pending') return
      setRecording(null)
      if (capture.kind === 'cancel') return setNotice(null)
      if (capture.kind === 'unsupported') return setNotice({ tone: 'error', text: 'That key cannot be used as a shortcut.' })
      apply(hotkeys.set(recording, capture.accelerator))
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recording, hotkeys, platform, apply])

  if (!hotkeys) return null

  return (
    <section aria-label="Global hotkeys" className="mt-6">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-zinc-400">
          <Keyboard size={15} /> Global hotkeys
        </h3>
        <button className={button} onClick={() => apply(hotkeys.reset())}>
          Reset
        </button>
      </div>
      <p className="mb-3 text-sm text-zinc-400">Work even when Wavelocal is in the background or hidden in the tray.</p>

      <ul className="flex flex-col gap-2">
        {DESKTOP_COMMANDS.map((command) => {
          const entry = state?.[command]
          const isRecording = recording === command
          const label = COMMAND_LABELS[command]
          return (
            <li key={command} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-white/5 px-3 py-2">
              <span className="text-sm font-medium">{label}</span>
              <span className="flex items-center gap-2">
                <kbd
                  className={`min-w-[7rem] rounded-lg px-2.5 py-1 text-center text-sm ${isRecording ? 'bg-accent/20 text-accent' : 'bg-base/60 text-zinc-200'}`}
                  aria-live="polite"
                >
                  {isRecording ? 'Press a key…' : entry?.accelerator ? displayAccelerator(entry.accelerator, platform) : 'Off'}
                </kbd>
                {entry?.status === 'taken' && !isRecording && (
                  <span className="text-xs text-amber-400" title="Another application is using this shortcut">
                    In use elsewhere
                  </span>
                )}
                <button className={button} aria-label={`${isRecording ? 'Cancel recording' : 'Record'} shortcut for ${label}`} onClick={() => setRecording(isRecording ? null : command)}>
                  {isRecording ? 'Cancel' : 'Record'}
                </button>
                <button className={button} aria-label={`Clear shortcut for ${label}`} disabled={!entry?.accelerator} onClick={() => apply(hotkeys.set(command, null))}>
                  Clear
                </button>
              </span>
            </li>
          )
        })}
      </ul>

      <p role="status" className={`mt-2 min-h-[1.25rem] text-sm ${notice?.tone === 'error' ? 'text-red-400' : 'text-zinc-400'}`}>
        {notice?.text ?? ''}
      </p>
    </section>
  )
}
