/** Bounded-concurrency work queue used by the importer and the library upgrade. */

export interface PoolOptions<T, R> {
  /** Stop starting new work once this fires; work that already started is allowed to finish. */
  signal?: AbortSignal
  /** Called after every finished item with how many are done out of the total. */
  onProgress?: (done: number, total: number) => void
  /** Called when a worker throws; what it returns becomes that item's result. Without it the result is `undefined`. */
  onError?: (error: unknown, item: T, index: number) => R
}

export interface PoolResult<R> {
  /** One entry per input, in input order. Items that never started (after an abort) or failed without `onError` are `undefined`. */
  results: (R | undefined)[]
  /** How many items finished (successfully or not). */
  completed: number
  /** True when an abort left some items unstarted. */
  aborted: boolean
}

/**
 * Run `worker` over `items` with at most `limit` in flight. A failure in one item never affects the others, and the
 * results come back in input order whatever order the work finishes in.
 */
export async function runPool<T, R>(items: readonly T[], limit: number, worker: (item: T, index: number) => Promise<R>, options: PoolOptions<T, R> = {}): Promise<PoolResult<R>> {
  const total = items.length
  const results: (R | undefined)[] = new Array<R | undefined>(total).fill(undefined)
  const { signal, onProgress, onError } = options
  let next = 0
  let done = 0

  const lane = async (): Promise<void> => {
    for (;;) {
      if (signal?.aborted) return
      const index = next++
      if (index >= total) return
      const item = items[index] as T
      try {
        results[index] = await worker(item, index)
      } catch (error) {
        try {
          results[index] = onError ? onError(error, item, index) : undefined
        } catch {
          results[index] = undefined
        }
      }
      done++
      try {
        onProgress?.(done, total)
      } catch {
        // a broken progress listener must not stop the import
      }
    }
  }

  const width = Math.max(1, Math.min(Math.floor(limit) || 1, total))
  await Promise.all(Array.from({ length: total ? width : 0 }, lane))
  return { results, completed: done, aborted: Boolean(signal?.aborted) && done < total }
}
