import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, FormEvent, KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { Download, ImagePlus, Loader2, Trash2, Undo2, X } from 'lucide-react'
import Cover from './Cover'
import { useDialog } from '../hooks/useA11y'
import { MAX_FIELD_LENGTH, cleanField, readCover } from '../lib/tags'
import type { PlayerApi, Track } from '../types'

interface TagEditorProps {
  p: PlayerApi
  track: Track
  onClose: () => void
}

/** What the user chose for the artwork: leave it, remove it, or use a new image (with a preview URL). */
type CoverChoice = { kind: 'keep' } | { kind: 'remove' } | { kind: 'replace'; blob: Blob; preview: string }

const field = 'w-full rounded-lg bg-raised px-3 py-2 text-sm outline-none ring-1 ring-white/10 focus:ring-accent'
const ghost = 'inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 text-xs font-semibold text-zinc-200 hover:bg-white/15 disabled:opacity-40'
const shownArtist = (t: Track): string => (t.artist === 'Unknown Artist' ? '' : t.artist)

/** Save a stored track (with its edited tags) as a regular file download. */
function downloadTrack(track: Track): void {
  const url = URL.createObjectURL(track.file)
  const a = document.createElement('a')
  a.href = url
  a.download = track.file.name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** Modal editor for a track's title, artist, album and cover art. */
export default function TagEditor({ p, track, onClose }: TagEditorProps) {
  const id = useId()
  const [title, setTitle] = useState(track.title)
  const [artist, setArtist] = useState(shownArtist(track))
  const [album, setAlbum] = useState(track.album)
  const [cover, setCover] = useState<CoverChoice>({ kind: 'keep' })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const dialog = useRef<HTMLDivElement>(null)
  const titleInput = useRef<HTMLInputElement>(null)
  const filePicker = useRef<HTMLInputElement>(null)
  const previewUrl = cover.kind === 'replace' ? cover.preview : null

  // focus goes to the title (selected), Tab stays inside, and focus returns to the row's pencil button on close
  useDialog(dialog, true, { initialFocus: '[data-autofocus]' })
  useEffect(() => titleInput.current?.select(), [])

  // never leak the preview object URL
  useEffect(() => {
    if (!previewUrl) return undefined
    return () => URL.revokeObjectURL(previewUrl)
  }, [previewUrl])

  const dirty = useMemo(
    () => cleanField(title) !== track.title || cleanField(artist) !== shownArtist(track) || cleanField(album) !== track.album || cover.kind !== 'keep',
    [title, artist, album, cover.kind, track],
  )

  const shownCover = cover.kind === 'replace' ? cover.preview : cover.kind === 'remove' ? null : track.cover

  const pickCover = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    const checked = await readCover(file)
    if (!checked.ok) return setError(checked.reason)
    const blob = new Blob([checked.bytes], { type: checked.mime })
    setError('')
    setCover({ kind: 'replace', blob, preview: URL.createObjectURL(blob) })
  }

  const save = async (e?: FormEvent) => {
    e?.preventDefault()
    if (busy || !dirty) return
    setBusy(true)
    setError('')
    const outcome = await p.editTags(track.id, {
      title,
      artist,
      album,
      ...(cover.kind === 'remove' ? { cover: null } : cover.kind === 'replace' ? { cover: cover.blob } : {}),
    })
    setBusy(false)
    if (!outcome.ok) return setError(outcome.error)
    onClose()
  }

  // Esc closes (and is not passed on to the sheets behind)
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape') return
    e.preventDefault()
    e.stopPropagation()
    onClose()
  }

  // portalled so no transformed ancestor (sheets, panels) can confine the fixed overlay
  return createPortal(
    <div data-modal="true" className="fixed inset-0 z-[85] grid place-items-center p-4" onKeyDown={onKeyDown}>
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby={`${id}-h`} className="relative max-h-[92dvh] w-full max-w-md animate-fadeIn overflow-y-auto rounded-2xl bg-panel p-5 shadow-2xl ring-1 ring-white/10">
        <div className="mb-4 flex items-center justify-between">
          <h2 id={`${id}-h`} className="text-lg font-semibold">Edit tags</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="grid h-9 w-9 place-items-center rounded-full text-zinc-400 hover:bg-white/10 hover:text-white">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={save} className="space-y-4">
          <div className="flex items-center gap-4">
            <div className="h-24 w-24 shrink-0 overflow-hidden rounded-xl ring-1 ring-white/10" data-testid="tag-cover">
              <Cover track={{ cover: shownCover, title, artist }} className="h-full w-full" iconSize={32} />
            </div>
            <div className="flex flex-wrap gap-2">
              <input ref={filePicker} type="file" accept="image/jpeg,image/png,image/gif,image/webp" hidden onChange={pickCover} aria-label="Cover image file" />
              <button type="button" onClick={() => filePicker.current?.click()} className={ghost}>
                <ImagePlus size={14} /> Choose image
              </button>
              <button type="button" onClick={() => setCover({ kind: 'remove' })} disabled={cover.kind === 'remove' || (cover.kind === 'keep' && !track.cover)} className={ghost}>
                <Trash2 size={14} /> Remove
              </button>
              <button type="button" onClick={() => setCover({ kind: 'keep' })} disabled={cover.kind === 'keep'} className={ghost}>
                <Undo2 size={14} /> Undo
              </button>
            </div>
          </div>

          <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-400">
            Title
            <input ref={titleInput} data-autofocus value={title} onChange={(e) => setTitle(e.target.value)} maxLength={MAX_FIELD_LENGTH} className={`mt-1 ${field} normal-case tracking-normal text-white`} />
          </label>
          <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-400">
            Artist
            <input value={artist} onChange={(e) => setArtist(e.target.value)} maxLength={MAX_FIELD_LENGTH} placeholder="Unknown Artist" className={`mt-1 ${field} normal-case tracking-normal text-white`} />
          </label>
          <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-400">
            Album
            <input value={album} onChange={(e) => setAlbum(e.target.value)} maxLength={MAX_FIELD_LENGTH} className={`mt-1 ${field} normal-case tracking-normal text-white`} />
          </label>

          <p className="text-xs text-zinc-400">
            Changes are saved to your offline library. MP3 files also get the tags written into the stored copy; your original file on disk is never modified.
          </p>

          {error && (
            <p role="alert" className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-300">
              {error}
            </p>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2">
            <button type="button" onClick={() => downloadTrack(track)} className={ghost} title="Download the stored copy with its tags">
              <Download size={14} /> Download copy
            </button>
            <div className="flex gap-2">
              <button type="button" onClick={onClose} className="rounded-full bg-white/10 px-4 py-2 text-sm font-semibold hover:bg-white/15">
                Cancel
              </button>
              <button type="submit" disabled={!dirty || busy} className="inline-flex items-center gap-2 rounded-full bg-accent px-5 py-2 text-sm font-semibold text-on-accent disabled:opacity-40">
                {busy && <Loader2 size={14} className="animate-spin" />} Save
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  )
}
