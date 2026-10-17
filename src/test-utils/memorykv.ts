import type { KeyValue } from '../lib/rawdb'

/** What the tests can poke at: the data itself, and switches that make the next calls fail the way a full or blocked disk does. */
export interface MemoryKv extends KeyValue {
  data: Map<string, unknown>
  fail: { get: boolean; set: boolean }
}

/**
 * A `KeyValue` in memory. Like IndexedDB it copies values going in and coming out (structured clone, so typed arrays stay
 * typed arrays), so a test cannot pass by sharing an object the real database would have copied.
 */
export function memoryKv(initial: Record<string, unknown> = {}): MemoryKv {
  const data = new Map<string, unknown>(Object.entries(initial))
  const fail = { get: false, set: false }
  return {
    data,
    fail,
    get: async (key) => {
      if (fail.get) throw new DOMException('The database is not available', 'InvalidStateError')
      return data.has(key) ? structuredClone(data.get(key)) : undefined
    },
    set: async (key, value) => {
      if (fail.set) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
      data.set(key, structuredClone(value))
    },
    delete: async (key) => {
      data.delete(key)
    },
    keys: async (prefix) => [...data.keys()].filter((key) => key.startsWith(prefix)).sort(),
  }
}
