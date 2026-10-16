import RovingGroup from './RovingGroup'
import { BROWSE_MODES } from '../lib/browse'
import type { BrowseMode } from '../lib/browse'

interface ModeTabsProps {
  mode: BrowseMode
  /** The modes on offer, in the order of `BROWSE_MODES`. */
  modes: readonly BrowseMode[]
  onChange: (mode: BrowseMode) => void
  /** Unique prefix tying the tabs to their panel (`${idBase}-panel`) so two panels on a page never share ids. */
  idBase: string
}

/** Tracks, Albums, Artists, Folders: the ways to look at the list on screen. Arrow keys move and choose. */
export default function ModeTabs({ mode, modes, onChange, idBase }: ModeTabsProps) {
  return (
    <div className="px-4 pb-2">
      <RovingGroup role="tablist" label="Browse by" className="flex gap-1 rounded-full bg-white/5 p-1">
        {BROWSE_MODES.filter((m) => modes.includes(m.mode)).map((m) => (
          <button
            key={m.mode}
            type="button"
            role="tab"
            id={`${idBase}-${m.mode}`}
            aria-selected={mode === m.mode}
            aria-controls={`${idBase}-panel`}
            tabIndex={mode === m.mode ? 0 : -1}
            onClick={() => onChange(m.mode)}
            className={`min-w-0 flex-1 truncate rounded-full px-2 py-1 text-xs font-semibold transition ${mode === m.mode ? 'bg-white text-black' : 'text-zinc-300 hover:bg-white/10'}`}
          >
            {m.label}
          </button>
        ))}
      </RovingGroup>
    </div>
  )
}
