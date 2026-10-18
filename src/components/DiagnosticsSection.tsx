import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { Bug, Copy, Trash2 } from 'lucide-react'
import { diagnostics } from '../lib/diagnostics/log'
import { appBuild, buildReport, describeBrowser } from '../lib/diagnostics/report'
import { toast } from '../lib/overlays'

const button = 'inline-flex items-center gap-2 rounded-full bg-white/10 px-4 py-2 text-sm font-semibold text-zinc-200 transition hover:bg-white/15 disabled:opacity-40'

const entriesLabel = (n: number): string => `${n} ${n === 1 ? 'entry' : 'entries'}`

/**
 * The errors Wavelocal ran into on this device, in the words the report will have: names, paths and quoted text are already taken
 * out of them. The report is copied only when asked for, and nothing is sent anywhere.
 */
export default function DiagnosticsSection() {
  const entries = useSyncExternalStore(diagnostics.subscribe, diagnostics.snapshot)
  const [report, setReport] = useState<string | null>(null) // the report, shown for copying by hand when the browser refuses the clipboard
  useEffect(() => {
    diagnostics.refresh() // another window may have recorded something since this one started
  }, [])
  const newestFirst = useMemo(() => [...entries].reverse(), [entries])

  const copy = async () => {
    const text = buildReport(diagnostics.snapshot(), { build: appBuild(), browser: describeBrowser(navigator.userAgent), now: Date.now() })
    try {
      await navigator.clipboard.writeText(text)
      setReport(null)
      toast('Report copied. File names, tags and settings are left out.')
    } catch {
      setReport(text)
      toast('The browser would not copy it. The report is shown here to select and copy.')
    }
  }

  const clear = () => {
    const removed = diagnostics.clear()
    setReport(null)
    toast(`Cleared ${entriesLabel(removed.length)}.`, { action: { label: 'Undo', run: () => diagnostics.restore(removed) } })
  }

  return (
    <section aria-label="Diagnostics" className="mt-6">
      <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-zinc-400">
        <Bug size={15} /> Diagnostics
      </h3>
      <p className="mb-3 text-xs text-zinc-400">
        Errors Wavelocal ran into are kept here, on this device only, so that you can tell someone what happened. Nothing is sent anywhere. A copied report holds
        this list and where in the app each error happened; names of files, tags and settings are left out.
      </p>
      {entries.length === 0 ? (
        <p className="text-sm text-zinc-300" role="status">
          No errors recorded.
        </p>
      ) : (
        <ol tabIndex={0} aria-label="Recorded errors" className="max-h-64 divide-y divide-white/5 overflow-y-auto rounded-2xl bg-white/5">
          {newestFirst.map((entry, index) => (
            <li key={`${index}-${entry.at}-${entry.kind}`} className="px-3 py-2">
              <div className="flex flex-wrap items-center gap-x-2 text-xs text-zinc-400">
                <time dateTime={new Date(entry.at).toISOString()}>{new Date(entry.at).toLocaleString([], { dateStyle: 'short', timeStyle: 'medium' })}</time>
                <span className="rounded bg-white/10 px-1.5 py-0.5 font-semibold uppercase tracking-wide text-zinc-300">{entry.kind}</span>
                {entry.count > 1 && <span>{`×${entry.count}`}</span>}
              </div>
              <p className="break-words text-sm text-zinc-100">{entry.message ? `${entry.name}: ${entry.message}` : entry.name}</p>
            </li>
          ))}
        </ol>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" className={button} disabled={entries.length === 0} onClick={() => void copy()}>
          <Copy size={15} /> Copy report
        </button>
        <button type="button" className={button} disabled={entries.length === 0} onClick={clear}>
          <Trash2 size={15} /> Clear log
        </button>
      </div>
      {report !== null && (
        <textarea
          readOnly
          aria-label="Report"
          value={report}
          onFocus={(event) => event.currentTarget.select()}
          className="mt-3 h-40 w-full rounded-xl bg-black/30 p-3 font-mono text-xs text-zinc-200"
        />
      )}
    </section>
  )
}
