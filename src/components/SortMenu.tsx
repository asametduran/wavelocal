import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { ArrowDown, ArrowUp, ArrowUpDown, Check } from 'lucide-react'
import { useRovingKeys } from '../hooks/useA11y'
import type { SortDir } from '../lib/sort'

export interface SortOption<K extends string> {
  key: K
  label: string
  /** The direction people usually want first for this key. */
  dir: SortDir
}

interface Spec<K extends string> {
  key: K
  dir: SortDir
}

interface SortMenuProps<K extends string> {
  /** What is being sorted, for the accessible names: "tracks", "albums". */
  noun: string
  options: readonly SortOption<K>[]
  value: Spec<K>
  onChange: (next: Spec<K>) => void
  /** The sort in a few words ("Title, A to Z"), for the button's name. */
  describe: (spec: Spec<K>) => string
  /** What a direction means for a key ("A to Z", "newest first"). */
  words: (key: K, dir: SortDir) => string
  /** The key that means the order the list is stored in; it has no direction. */
  stored?: K
  className?: string
}

/**
 * A sort button with a menu of keys, and a second button that flips the direction. Keys are menu radio items (arrow
 * keys move, Enter chooses, Escape closes and gives focus back); the direction button names both directions in words.
 */
export default function SortMenu<K extends string>({ noun, options, value, onChange, describe, words, stored, className = '' }: SortMenuProps<K>) {
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const navigate = useRovingKeys({ items: '[role="menuitemradio"]', orientation: 'vertical' })
  const current = options.find((o) => o.key === value.key) ?? options[0]
  const directional = value.key !== stored
  const flipped: SortDir = value.dir === 'asc' ? 'desc' : 'asc'

  // the menu opens with the chosen key focused
  useEffect(() => {
    if (open) menu.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus()
  }, [open])

  const close = (restoreFocus: boolean) => {
    setOpen(false)
    if (restoreFocus) requestAnimationFrame(() => button.current?.focus())
  }
  const choose = (option: SortOption<K>) => {
    if (option.key !== value.key) onChange({ key: option.key, dir: option.dir })
    close(true)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close(true)
    } else if (e.key === 'Tab') close(false)
    else navigate(e)
  }

  return (
    <div className={`relative flex min-w-0 items-center gap-0.5 ${className}`}>
      <button
        ref={button}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Sort ${noun}: ${describe(value)}`}
        title={`Sort ${noun}`}
        className="flex min-w-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium text-zinc-300 hover:bg-white/10 hover:text-white"
      >
        <ArrowUpDown size={13} className="shrink-0" aria-hidden="true" />
        <span className="truncate">{current?.label}</span>
      </button>
      {directional && (
        <button
          type="button"
          onClick={() => onChange({ key: value.key, dir: flipped })}
          aria-label={`Sort order: ${words(value.key, value.dir)}. Switch to ${words(value.key, flipped)}`}
          title={words(value.key, value.dir)}
          className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-zinc-300 hover:bg-white/10 hover:text-white"
        >
          {value.dir === 'asc' ? <ArrowUp size={14} aria-hidden="true" /> : <ArrowDown size={14} aria-hidden="true" />}
        </button>
      )}
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => close(false)} aria-hidden="true" />
          <div ref={menu} role="menu" aria-label={`Sort ${noun} by`} onKeyDown={onKeyDown} className="absolute right-0 top-full z-20 mt-1 w-56 overflow-hidden rounded-xl bg-raised py-1 shadow-xl ring-1 ring-white/10">
            {options.map((option) => {
              const checked = option.key === value.key
              return (
                <button key={option.key} type="button" role="menuitemradio" aria-checked={checked} tabIndex={-1} onClick={() => choose(option)} className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-white/10 ${checked ? 'font-semibold text-accent' : ''}`}>
                  <span className="grid w-4 shrink-0 place-items-center" aria-hidden="true">
                    {checked && <Check size={14} />}
                  </span>
                  {option.label}
                </button>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
