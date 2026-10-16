import { useRef, useState } from 'react'
import { DatabaseBackup, Download, Upload } from 'lucide-react'
import { MAX_BACKUP_BYTES, backupFileName, parseBackup } from '../lib/backup'
import type { Backup, RestoreSummary } from '../lib/backup'
import type { PlayerApi } from '../types'

const button = 'inline-flex items-center gap-2 rounded-full bg-white/10 px-4 py-2 text-sm font-semibold text-zinc-200 transition hover:bg-white/15 disabled:opacity-40'
const primary = 'inline-flex items-center gap-2 rounded-full bg-accent px-4 py-2 text-sm font-semibold text-on-accent transition hover:opacity-90 disabled:opacity-40'

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`

type Step =
  | { kind: 'idle' }
  | { kind: 'preview'; backup: Backup; summary: RestoreSummary; fileName: string; skipped: number }
  | { kind: 'done'; summary: RestoreSummary }

/** What a restore will do (or did), in plain sentences. */
function Summary({ s, done }: { s: RestoreSummary; done: boolean }) {
  const lines: string[] = []
  lines.push(`${plural(s.tracksInBackup, 'track')} in the backup: ${s.matched.toLocaleString()} already in your library, ${s.waiting.toLocaleString()} not yet.`)
  if (s.updated) lines.push(`${done ? 'Updated' : 'Will update'} tags, lyrics or play counts of ${plural(s.updated, 'track')}.`)
  else if (s.matched) lines.push('The tracks you have already match the backup.')
  if (s.playlistsInBackup) {
    const parts = [s.playlistsCreated && `${done ? 'added' : 'add'} ${plural(s.playlistsCreated, 'playlist')}`, s.playlistsMerged && `${done ? 'merged' : 'merge'} ${plural(s.playlistsMerged, 'playlist')}`].filter(Boolean)
    if (parts.length) lines.push(`Playlists: ${parts.join(' and ')}${s.membersAdded ? `, putting ${plural(s.membersAdded, 'track')} into them` : ''}.`)
  }
  if (s.waiting) lines.push(`The ${plural(s.waiting, 'track')} you do not have yet are remembered: add those files and their playlists, play counts and tags fill in by themselves.`)
  return (
    <ul className="list-disc space-y-1 pl-5 text-sm text-zinc-300">
      {lines.map((l) => (
        <li key={l}>{l}</li>
      ))}
    </ul>
  )
}

/**
 * Back up the library's metadata and playlists to one JSON file, and restore from one. The file never contains audio
 * or artwork; restoring merges into the library and completes by itself as missing files are added.
 */
export default function BackupSection({ p }: { p: PlayerApi }) {
  const input = useRef<HTMLInputElement>(null)
  const [step, setStep] = useState<Step>({ kind: 'idle' })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const download = () => {
    setError(null)
    const blob = new Blob([p.exportBackup()], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = backupFileName(new Date())
    document.body.append(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }

  const choose = async (file: File | undefined) => {
    if (!file) return
    setError(null)
    setStep({ kind: 'idle' })
    if (file.size > MAX_BACKUP_BYTES) return setError('That file is too large to be a Wavelocal backup.')
    setBusy(true)
    try {
      const parsed = parseBackup(await file.text())
      if (!parsed.ok) return setError(parsed.error)
      setStep({ kind: 'preview', backup: parsed.backup, summary: p.previewBackup(parsed.backup), fileName: file.name, skipped: parsed.skipped })
    } catch {
      setError('Could not read that file.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section aria-label="Backup and restore" className="mt-6">
      <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-zinc-400">
        <DatabaseBackup size={15} /> Backup &amp; restore
      </h3>
      <p className="mb-3 text-xs text-zinc-400">
        Save your playlists, tags, lyrics and play counts to a small file. It holds no audio or artwork, only text about your library (including what you listened to), and goes wherever you save it.
      </p>

      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={download} disabled={!p.tracks.length && !p.playlists.length} className={button}>
          <Download size={15} /> Export backup
        </button>
        <button type="button" onClick={() => input.current?.click()} disabled={busy} className={button}>
          <Upload size={15} /> Restore from backup…
        </button>
        <input ref={input} type="file" accept=".json,application/json" hidden aria-label="Backup file" onChange={(e) => (void choose(e.target.files?.[0]), (e.target.value = ''))} />
      </div>

      {error && (
        <p role="alert" className="mt-3 rounded-xl bg-red-500/15 px-3 py-2 text-sm text-red-200">
          {error}
        </p>
      )}

      {step.kind === 'preview' && (
        <div role="group" aria-label="Restore preview" className="mt-3 space-y-3 rounded-2xl bg-white/5 p-3">
          <p className="text-sm">
            <strong>{step.fileName}</strong>
            {step.backup.exportedAt ? <span className="text-zinc-400"> · saved {new Date(step.backup.exportedAt).toLocaleString()}</span> : null}
          </p>
          <Summary s={step.summary} done={false} />
          <p className="text-xs text-zinc-400">Nothing is removed. Tags and lyrics in the backup replace the ones in your library; play counts only ever go up.</p>
          {step.skipped > 0 && <p className="text-xs text-zinc-400">{plural(step.skipped, 'damaged entry', 'damaged entries')} in the file will be skipped.</p>}
          <div className="flex gap-2">
            <button
              type="button"
              className={primary}
              onClick={() => {
                setStep({ kind: 'done', summary: p.applyBackup(step.backup) })
              }}
            >
              Restore
            </button>
            <button type="button" className={button} onClick={() => setStep({ kind: 'idle' })}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {step.kind === 'done' && (
        <div role="status" className="mt-3 space-y-2 rounded-2xl bg-white/5 p-3">
          <p className="text-sm font-semibold">Backup restored.</p>
          <Summary s={step.summary} done />
        </div>
      )}

      {p.pendingRestoreCount > 0 && (
        <div role="status" className="mt-3 flex items-center justify-between gap-3 rounded-xl bg-white/5 px-3 py-2 text-sm text-zinc-300">
          <span>{plural(p.pendingRestoreCount, 'track')} from a backup {p.pendingRestoreCount === 1 ? 'is' : 'are'} waiting for their files.</span>
          <button type="button" onClick={p.discardPendingRestore} className="shrink-0 font-semibold text-accent">
            Stop waiting
          </button>
        </div>
      )}
    </section>
  )
}
