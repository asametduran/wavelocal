import { Loader2, X } from 'lucide-react'
import type { PlayerApi } from '../types'

const count = new Intl.NumberFormat()

/** A width in characters that the text never outgrows, so the pill (and the Cancel button inside it) holds still as the numbers change. */
const textWidth = (prefix: string, total: number): string => `${prefix.length + 2 * count.format(total).length + 3}ch`

interface BarProps {
  label: string
  done: number
  total: number
}

/** A thin progress bar. The numbers beside it are decoration (they change many times a second); the bar is what assistive tech can ask for. */
function Bar({ label, done, total }: BarProps) {
  const pct = total ? Math.round((done / total) * 100) : 0
  return (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} className="h-1 w-40 overflow-hidden rounded-full bg-white/10">
      <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${pct}%` }} />
    </div>
  )
}

/**
 * Shown while files are being imported (with a Cancel button), or, more quietly, while a library stored by an older
 * version is brought up to date in the background.
 */
export default function ImportStatus({ p }: { p: Pick<PlayerApi, 'importProgress' | 'cancelImport' | 'upgradeProgress'> }) {
  const importing = p.importProgress
  if (importing && importing.total > 0) {
    return (
      <div data-testid="import-status" className="fixed right-4 top-4 z-[60] flex items-center gap-3 rounded-full bg-raised py-2 pl-4 pr-2 text-sm shadow-lg">
        <Loader2 size={16} className="animate-spin text-accent" aria-hidden="true" />
        <div className="flex flex-col gap-1">
          <span aria-hidden="true" style={{ minWidth: textWidth('Reading tags… ', importing.total) }}>
            Reading tags… <span className="tabular-nums">{count.format(importing.done)} / {count.format(importing.total)}</span>
          </span>
          <Bar label="Reading files" done={importing.done} total={importing.total} />
        </div>
        <button type="button" onClick={p.cancelImport} className="grid h-8 w-8 place-items-center rounded-full text-zinc-300 hover:bg-white/10 hover:text-white" aria-label="Cancel import">
          <X size={16} />
        </button>
      </div>
    )
  }

  const upgrading = p.upgradeProgress
  if (upgrading && upgrading.total > 0) {
    return (
      <div data-testid="upgrade-status" className="fixed right-4 top-4 z-[60] flex items-center gap-3 rounded-full bg-raised/90 px-4 py-2 text-xs text-zinc-300 shadow-lg">
        <Loader2 size={14} className="animate-spin text-accent" aria-hidden="true" />
        <div className="flex flex-col gap-1">
          <span aria-hidden="true" style={{ minWidth: textWidth('Updating library details… ', upgrading.total) }}>
            Updating library details… <span className="tabular-nums">{count.format(upgrading.done)} / {count.format(upgrading.total)}</span>
          </span>
          <Bar label="Updating library details" done={upgrading.done} total={upgrading.total} />
        </div>
      </div>
    )
  }
  return null
}
