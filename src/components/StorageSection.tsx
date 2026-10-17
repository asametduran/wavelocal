import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { HardDrive, RefreshCw, ShieldAlert, ShieldCheck, Trash2 } from 'lucide-react'
import { confirmDialog, toast } from '../lib/overlays'
import { offline } from '../lib/offline/instance'
import type { OfflineSnapshot } from '../lib/offline/updates'
import { assessStorage, breakdown, formatBytes, formatPercent, largestTracks, libraryUsage, readEstimate, readPersisted, requestPersistence, warningFor } from '../lib/storage'
import type { StorageEstimate } from '../lib/storage'
import { countLabel } from '../lib/format'
import type { PlayerApi } from '../types'

const button = 'inline-flex items-center gap-2 rounded-full bg-white/10 px-4 py-2 text-sm font-semibold text-zinc-200 transition hover:bg-white/15 disabled:opacity-40'
const primary = 'inline-flex items-center gap-2 rounded-full bg-accent px-4 py-2 text-sm font-semibold text-on-accent transition hover:opacity-90 disabled:opacity-40'

const LARGEST = 8

/** Why there is no offline copy, in a sentence. */
const NO_COPY: Partial<Record<OfflineSnapshot['reason'], string>> = {
  managed: 'This app already runs from files on your device, so it needs no extra offline copy.',
  development: 'This is a development build: it is never cached, so changes show up at once.',
  unsupported: 'This browser cannot keep an offline copy here (it needs a secure address, and some private windows block it).',
  blocked: 'The browser refused to keep an offline copy. Private windows often do.',
}

function OfflineCopy() {
  const state = useSyncExternalStore(offline.subscribe, offline.snapshot)
  const [busy, setBusy] = useState(false)

  const check = async () => {
    setBusy(true)
    try {
      const result = await offline.check()
      toast(
        result === 'update'
          ? 'A new version is downloading.'
          : result === 'current'
            ? 'Wavelocal is up to date.'
            : result === 'offline'
              ? 'Could not reach the server to look for updates.'
              : 'Updates are not available here.',
      )
    } finally {
      setBusy(false)
    }
  }

  const reset = async () => {
    const yes = await confirmDialog({
      title: 'Download the app again?',
      message: 'This deletes the offline copy of the app and downloads a fresh one. Your music, playlists and settings are not touched.',
      confirmLabel: 'Download again',
    })
    if (yes) await offline.repair()
  }

  const unavailable = NO_COPY[state.reason]
  const { status } = state

  return (
    <div className="mt-4 rounded-2xl bg-white/5 p-3" role="group" aria-label="Offline copy of the app">
      <h4 className="text-sm font-semibold text-zinc-200">Works offline</h4>
      {unavailable ? (
        <p className="mt-1 text-sm text-zinc-300">{unavailable}</p>
      ) : (
        <>
          <p className="mt-1 text-sm text-zinc-300" role="status">
            {state.reason === 'pending'
              ? 'Checking…'
              : status === null
                ? 'Not active yet. It starts after the next reload.'
                : status.complete
                  ? `Ready: all ${countLabel(status.entries, 'file')} of the app (${formatBytes(status.bytes)}) are saved, so Wavelocal opens with no connection. Version ${status.version}.`
                  : 'Saving the app for offline use…'}
          </p>
          {state.stage === 'ready' && (
            <p className="mt-2 rounded-xl bg-accent/15 px-3 py-2 text-sm text-zinc-100" role="status">
              {state.updatedElsewhere ? 'Wavelocal was updated in another window. Reload to use the new version here.' : 'A new version is ready. Reload to use it (playback stops, and your place is remembered).'}
            </p>
          )}
          {state.stage === 'downloading' && (
            <p className="mt-2 text-sm text-zinc-300" role="status">
              Downloading a new version…
            </p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            {state.stage === 'ready' ? (
              <button type="button" className={primary} onClick={() => offline.apply()}>
                <RefreshCw size={15} /> Reload to update
              </button>
            ) : (
              <button type="button" className={button} onClick={() => void check()} disabled={busy || state.stage === 'checking' || state.stage === 'downloading' || state.reason !== 'active'}>
                <RefreshCw size={15} className={busy || state.stage === 'checking' ? 'animate-spin' : ''} /> Check for updates
              </button>
            )}
            <button type="button" className={button} onClick={() => void reset()} disabled={state.reason !== 'active'}>
              Download the app again
            </button>
          </div>
          {state.checkedAt !== null && <p className="mt-2 text-xs text-zinc-400">Last checked {new Date(state.checkedAt).toLocaleTimeString()}.</p>}
        </>
      )}
    </div>
  )
}

/**
 * How much room the library takes, how much the device has left, whether the browser may delete the library, and the tracks
 * that cost the most. Also the offline copy of the app: whether it is saved and whether a newer version is waiting.
 */
export default function StorageSection({ p }: { p: PlayerApi }) {
  const [estimate, setEstimate] = useState<StorageEstimate | null | undefined>(undefined)
  const [persisted, setPersisted] = useState<boolean | null>(null)
  const [version, setVersion] = useState(0)
  const refresh = useCallback(() => setVersion((v) => v + 1), [])

  // read again whenever the library changes size, or after something here changed storage
  useEffect(() => {
    let current = true
    void Promise.all([readEstimate(), readPersisted()]).then(([e, keep]) => {
      if (!current) return
      setEstimate(e)
      setPersisted(keep)
    })
    return () => {
      current = false
    }
  }, [p.tracks.length, version])

  const library = useMemo(() => libraryUsage(p.tracks), [p.tracks])
  const largest = useMemo(() => largestTracks(p.tracks, LARGEST), [p.tracks])
  const offlineStatus = useSyncExternalStore(offline.subscribe, offline.snapshot).status

  const assessment = assessStorage(estimate ?? null)
  const warning = warningFor(assessment, persisted)
  const split = estimate ? breakdown(estimate.usage, library.total, offlineStatus?.bytes ?? 0) : null
  const share = (bytes: number) => (estimate ? `${Math.min(100, (bytes / estimate.quota) * 100)}%` : '0%')

  const protect = async () => {
    const granted = await requestPersistence()
    refresh()
    toast(
      granted
        ? 'Your library is protected: the browser will not delete it when space runs low.'
        : granted === false
          ? 'The browser did not agree. It usually does for apps you have installed or use often.'
          : 'This browser cannot be asked to protect the library.',
    )
  }

  const remove = async (id: string, title: string, bytes: number) => {
    const yes = await confirmDialog({
      title: 'Remove from your library?',
      message: `"${title}" (${formatBytes(bytes)}) is removed from Wavelocal, with its play count and its place in playlists. The original file on your device is not touched.`,
      confirmLabel: 'Remove',
      danger: true,
    })
    if (!yes) return
    p.removeFromLibrary(id)
    toast(`Removed "${title}" and freed ${formatBytes(bytes)}.`)
    refresh()
  }

  return (
    <section aria-label="Storage" className="mt-6">
      <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-zinc-400">
        <HardDrive size={15} /> Storage
      </h3>
      <p className="mb-3 text-xs text-zinc-400">Wavelocal keeps its own copy of every track you add, inside this browser's storage. Nothing is uploaded anywhere.</p>

      {estimate === undefined ? (
        <p className="text-sm text-zinc-400" role="status">
          Checking storage…
        </p>
      ) : estimate === null || split === null ? (
        <p className="text-sm text-zinc-300">
          Your library is {formatBytes(library.total)} ({countLabel(library.tracks, 'track')}). This browser does not say how much room is left.
        </p>
      ) : (
        <div>
          <p className="mb-2 text-sm text-zinc-200">
            {formatBytes(estimate.usage)} used of {formatBytes(estimate.quota)} available ({formatPercent(assessment.fraction)})
          </p>
          <div
            role="meter"
            aria-label="Storage used"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(assessment.fraction * 100)}
            aria-valuetext={`${formatBytes(estimate.usage)} of ${formatBytes(estimate.quota)} used, ${formatBytes(assessment.free)} free`}
            className="flex h-3 w-full overflow-hidden rounded-full bg-white/10"
          >
            <div className="bg-accent" style={{ width: share(split.music), minWidth: split.music > 0 ? 2 : 0 }} />
            <div className="bg-zinc-300/70" style={{ width: share(split.app), minWidth: split.app > 0 ? 2 : 0 }} />
            <div className="bg-zinc-500/70" style={{ width: share(split.other), minWidth: split.other > 0 ? 2 : 0 }} />
          </div>
          <ul className="mt-3 space-y-1 text-sm text-zinc-300">
            <li className="flex items-center gap-2">
              <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full bg-accent" />
              <span>
                Music library: {formatBytes(split.music)} <span className="text-zinc-400">({countLabel(library.tracks, 'track')})</span>
              </span>
            </li>
            <li className="flex items-center gap-2">
              <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full bg-zinc-300/70" />
              <span>App files for offline use: {formatBytes(split.app)}</span>
            </li>
            <li className="flex items-center gap-2">
              <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full bg-zinc-500/70" />
              <span>Other: {formatBytes(split.other)}</span>
            </li>
            <li className="text-zinc-400">Free: {formatBytes(assessment.free)}</li>
          </ul>
        </div>
      )}

      {warning && (
        <p role={warning.level === 'critical' ? 'alert' : 'status'} className={`mt-3 rounded-xl px-3 py-2 text-sm ${warning.level === 'critical' ? 'bg-red-500/15 text-red-200' : 'bg-amber-500/15 text-amber-100'}`}>
          {warning.text}
        </p>
      )}

      {persisted !== null && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-white/5 p-3" role="group" aria-label="Protection from clean-up">
          <p className="flex min-w-0 flex-1 items-start gap-2 text-sm text-zinc-300">
            {persisted ? <ShieldCheck size={16} className="mt-0.5 shrink-0 text-accent" /> : <ShieldAlert size={16} className="mt-0.5 shrink-0 text-amber-300" />}
            <span>
              {persisted
                ? 'Protected: the browser will not delete your library when the device runs low on space.'
                : 'Not protected: if the device runs very low on space, the browser may delete this library. A backup (above) keeps your playlists and tags safe either way.'}
            </span>
          </p>
          {!persisted && (
            <button type="button" className={button} onClick={() => void protect()}>
              Protect my library
            </button>
          )}
        </div>
      )}

      {largest.length > 0 && (
        <div className="mt-4">
          <h4 className="mb-2 text-sm font-semibold text-zinc-200">Largest tracks</h4>
          <ul className="divide-y divide-white/5 rounded-2xl bg-white/5" aria-label="Largest tracks">
            {largest.map((track) => (
              <li key={track.id} className="flex items-center gap-3 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-zinc-100">{track.title}</p>
                  <p className="truncate text-xs text-zinc-400">
                    {[track.artist, track.plays ? `${countLabel(track.plays, 'play')}` : 'never played'].filter(Boolean).join(' · ')}
                  </p>
                </div>
                <span className="shrink-0 text-sm tabular-nums text-zinc-300">{formatBytes(track.bytes)}</span>
                <button
                  type="button"
                  aria-label={`Remove ${track.title} from the library`}
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-zinc-400 hover:bg-white/10 hover:text-red-300"
                  onClick={() => void remove(track.id, track.title, track.bytes)}
                >
                  <Trash2 size={16} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <OfflineCopy />
    </section>
  )
}
