import { useSyncExternalStore } from 'react'
import { Radio } from 'lucide-react'
import RovingGroup from './RovingGroup'
import { useProgressReady } from '../hooks/useProgress'
import { countLabel } from '../lib/format'
import { progressService } from '../lib/listening/instance'
import { longFormThreshold } from '../lib/listening/prefs'
import { SKIP_BACK, SKIP_FORWARD, THRESHOLDS } from '../lib/listening/progress'
import type { ThresholdId } from '../lib/listening/progress'
import { confirmDialog, toast } from '../lib/overlays'

const chip = (on: boolean) =>
  `rounded-full px-4 py-2 text-sm font-semibold transition ${on ? 'bg-accent text-on-accent' : 'bg-white/10 text-zinc-200 hover:bg-white/15'}`

/** What a choice of length means, in a sentence. */
function describe(id: ThresholdId): string {
  if (id === 'never') return 'Nothing is remembered because of its length. A single track can still be set to "Always" in its list of chapters and bookmarks.'
  if (id === 'all') return `Every file, songs too, remembers where you stopped and the speed you chose, and has buttons that skip ${SKIP_BACK} seconds back and ${SKIP_FORWARD} forward.`
  const minutes = Number(id)
  const length = minutes === 60 ? 'an hour' : `${minutes} minutes`
  return `Files longer than ${length} (podcasts, lectures, books) remember where you stopped and the speed you chose for them, and have buttons that skip ${SKIP_BACK} seconds back and ${SKIP_FORWARD} forward. Songs are left as they are.`
}

/**
 * Which tracks count as long recordings, and a way to forget what is kept about them. Where you stopped and the speed you chose
 * are kept on this device only (never in a backup), and this is the one place to see how much there is and to clear it.
 */
export default function LongFormSection() {
  const threshold = useSyncExternalStore(longFormThreshold.subscribe, longFormThreshold.get)
  const kept = useSyncExternalStore(progressService.subscribe, () => progressService.size)
  const ready = useProgressReady() // the first reader has what is kept read from the database

  const forget = async () => {
    const ok = await confirmDialog({
      title: 'Forget where you stopped?',
      message: `What is kept about ${countLabel(kept, 'recording')} (where you stopped, the speed you chose, and your choice to remember it or not) is removed from this device. Bookmarks are not touched.`,
      confirmLabel: 'Forget',
      danger: true,
    })
    if (!ok) return
    const gone = await progressService.clear()
    toast(gone > 0 ? `Forgot where you stopped in ${countLabel(gone, 'recording')}.` : 'There was nothing to forget.')
  }

  return (
    <section aria-label="Long recordings" className="mt-6">
      <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-zinc-400">
        <Radio size={15} /> Long recordings
      </h3>
      <RovingGroup role="radiogroup" label="Remember where I stopped" className="flex flex-wrap gap-2">
        {THRESHOLDS.map(({ id, label }) => (
          <button key={id} role="radio" aria-checked={threshold === id} tabIndex={threshold === id ? 0 : -1} onClick={() => longFormThreshold.set(id)} className={chip(threshold === id)}>
            {label}
          </button>
        ))}
      </RovingGroup>
      <p className="mt-2 text-xs text-zinc-400">{describe(threshold)}</p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button type="button" data-testid="forget-places" disabled={!ready || kept === 0} onClick={() => void forget()} className={`${chip(false)} !py-1 disabled:opacity-40`}>
          Forget saved places
        </button>
        <span className="text-xs text-zinc-400" role="status">
          {ready ? (kept === 0 ? 'Nothing is kept yet.' : `Kept for ${countLabel(kept, 'recording')}.`) : ''}
        </span>
      </div>
    </section>
  )
}
