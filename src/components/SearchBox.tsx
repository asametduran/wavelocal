import { useId, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { CircleHelp, Search, X } from 'lucide-react'

/** Examples of what the search understands; choosing one adds it to the search box. */
const TIPS: readonly { text: string; note: string }[] = [
  { text: 'artist:', note: 'tracks by an artist' },
  { text: 'album:', note: 'tracks on an album' },
  { text: 'year:1990s', note: 'a decade' },
  { text: 'year:2000..2010', note: 'a range of years' },
  { text: '"exact phrase"', note: 'words in a row' },
  { text: '-live', note: 'leave out a word' },
]

interface SearchBoxProps {
  value: string
  onChange: (value: string) => void
  inputRef?: RefObject<HTMLInputElement | null>
  /** The input's accessible name ("Search tracks"). */
  label: string
  /** The landmark's name ("Search library"). */
  landmark: string
  placeholder: string
}

/** The library search field: clears with a button or Escape, and explains what it understands on request. */
export default function SearchBox({ value, onChange, inputRef, label, landmark, placeholder }: SearchBoxProps) {
  const local = useRef<HTMLInputElement>(null)
  const input = inputRef ?? local
  const tipsId = useId()
  const [tips, setTips] = useState(false)
  const toggle = useRef<HTMLButtonElement>(null)

  const addTip = (text: string) => {
    onChange(value && !value.endsWith(' ') ? `${value} ${text}` : `${value}${text}`)
    const el = input.current
    if (el) requestAnimationFrame(() => (el.focus(), el.setSelectionRange(el.value.length, el.value.length)))
  }

  return (
    <div role="search" aria-label={landmark} className="px-4 pb-2">
      <div className="flex items-center gap-1">
        <label className="flex min-w-0 flex-1 items-center gap-2 rounded-lg bg-raised px-3 py-2 focus-within:ring-1 focus-within:ring-accent">
          <Search size={15} className="shrink-0 text-zinc-400" aria-hidden="true" />
          <input
            ref={input}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Escape') return
              if (value || tips) e.stopPropagation() // clearing is this key's job here; going back is for the next press
              onChange('')
              setTips(false)
              e.currentTarget.blur()
            }}
            placeholder={placeholder}
            aria-label={label}
            className="w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-zinc-400"
          />
          {value && (
            <button type="button" onClick={() => onChange('')} aria-label="Clear search" className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-zinc-400 hover:text-white">
              <X size={14} />
            </button>
          )}
        </label>
        <button
          ref={toggle}
          type="button"
          onClick={() => setTips((t) => !t)}
          aria-expanded={tips}
          aria-controls={tipsId}
          aria-label="Search tips"
          title="Search tips"
          className={`grid h-8 w-8 shrink-0 place-items-center rounded-full hover:bg-white/10 hover:text-white ${tips ? 'text-accent' : 'text-zinc-400'}`}
        >
          <CircleHelp size={16} />
        </button>
      </div>
      {tips && (
        <div
          id={tipsId}
          role="group"
          aria-label="Search tips"
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return
            e.preventDefault()
            e.stopPropagation()
            setTips(false)
            toggle.current?.focus()
          }}
          className="mt-2 rounded-xl bg-raised p-3 text-xs text-zinc-300"
        >
          <p>Every word has to match, in any order. Accents and capitals don&rsquo;t matter: <em className="not-italic text-white">istanbul</em> finds İstanbul.</p>
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {TIPS.map((tip) => (
              <li key={tip.text}>
                <button type="button" onClick={() => addTip(tip.text)} title={tip.note} aria-label={`Add ${tip.text} (${tip.note})`} className="rounded-full bg-white/10 px-2.5 py-1 font-mono text-[11px] text-white hover:bg-white/20">
                  {tip.text}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
