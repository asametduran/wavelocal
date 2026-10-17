import { useSyncExternalStore } from 'react'
import { AudioWaveform } from 'lucide-react'
import RovingGroup from './RovingGroup'
import { toolsRow } from '../lib/listening/prefs'
import type { ToolsRow } from '../lib/listening/prefs'
import { seekStyle } from '../lib/waveform/prefs'
import type { SeekStyle } from '../lib/waveform/prefs'

const OPTIONS: readonly (readonly [id: SeekStyle, label: string, description: string])[] = [
  ['waveform', 'Waveform', 'The seek bar shows the shape of the file. It is measured on this device, once for each track, and kept.'],
  ['plain', 'Plain bar', 'A simple line. Nothing is measured.'],
]

const ROWS: readonly (readonly [id: ToolsRow, label: string, description: string])[] = [
  ['auto', 'When useful', 'Buttons for looping a passage and for bookmarks appear under the seek bar for recordings with chapters, bookmarks or a long length, and while a loop is set. A song looks as it always did. The L and B keys always work.'],
  ['always', 'Always', 'Show the loop (A, B) and bookmark buttons under the seek bar of every track. This is how to reach them for a song on a phone, which has no keys.'],
]

const chip = (on: boolean) =>
  `rounded-full px-4 py-2 text-sm font-semibold transition ${on ? 'bg-accent text-on-accent' : 'bg-white/10 text-zinc-200 hover:bg-white/15'}`

/** Waveform or plain bar for the seek bar: one switch, which both seek bars (footer and phone sheet) follow at once. */
export default function SeekBarSection() {
  const style = useSyncExternalStore(seekStyle.subscribe, seekStyle.get)
  const row = useSyncExternalStore(toolsRow.subscribe, toolsRow.get)
  const current = OPTIONS.find(([id]) => id === style) ?? OPTIONS[0]
  const currentRow = ROWS.find(([id]) => id === row) ?? ROWS[0]
  return (
    <section aria-label="Seek bar" className="mt-6">
      <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-zinc-400">
        <AudioWaveform size={15} /> Seek bar
      </h3>
      <RovingGroup role="radiogroup" label="Seek bar style" className="flex flex-wrap gap-2">
        {OPTIONS.map(([id, label]) => (
          <button key={id} role="radio" aria-checked={style === id} tabIndex={style === id ? 0 : -1} onClick={() => seekStyle.set(id)} className={chip(style === id)}>
            {label}
          </button>
        ))}
      </RovingGroup>
      <p className="mt-2 text-xs text-zinc-400">{current?.[2]}</p>
      <RovingGroup role="radiogroup" label="Loop and bookmark buttons" className="mt-4 flex flex-wrap gap-2">
        {ROWS.map(([id, label]) => (
          <button key={id} role="radio" aria-checked={row === id} tabIndex={row === id ? 0 : -1} onClick={() => toolsRow.set(id)} className={chip(row === id)}>
            {label}
          </button>
        ))}
      </RovingGroup>
      <p className="mt-2 text-xs text-zinc-400">{currentRow?.[2]}</p>
    </section>
  )
}
