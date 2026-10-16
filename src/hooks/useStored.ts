import { useCallback, useState } from 'react'

/**
 * A value remembered on this device (in localStorage, as JSON) under `key`. `parse` repairs whatever is stored, so an
 * old, damaged or missing value is harmless. Storage that is blocked just means the choice lasts for this visit.
 */
export function useStored<T>(key: string, parse: (raw: unknown) => T): [value: T, set: (next: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key)
      return parse(raw ? (JSON.parse(raw) as unknown) : undefined)
    } catch {
      return parse(undefined)
    }
  })
  const set = useCallback(
    (next: T) => {
      setValue(next)
      try {
        localStorage.setItem(key, JSON.stringify(next))
      } catch {
        // blocked storage: nothing to do
      }
    },
    [key],
  )
  return [value, set]
}
