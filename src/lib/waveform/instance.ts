import { idbKeyValue } from '../rawdb'
import { createPeaksWorker } from './client'
import type { WorkerLike } from './client'
import { measureTrack } from './compute'
import { browserDecode } from './native'
import { PeaksService, delay } from './service'
import { prunePeaks } from './store'

/**
 * The page's one waveform service. The seek bar is mounted twice (footer and phone sheet) and both read this, so a track is
 * measured once. Only the lazy waveform chunk imports it.
 */

// a second instance of the decode worker: a waveform never queues behind a FLAC being converted for playback
const worker = createPeaksWorker(() => new Worker(new URL('../audio/decode.worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike)
const decode = browserDecode()

export const peaksService = new PeaksService({
  kv: idbKeyValue,
  wait: delay,
  measure: (target, signal) => measureTrack(target, signal, { lossless: (file, aborted) => worker.measure(file, aborted), decode }),
})

let pruned = false
/** Once per page, when the browser is idle: forget the waveforms of tracks that are no longer in the library. */
export function pruneOnce(known: ReadonlySet<string>): void {
  if (pruned) return
  pruned = true
  const run = () => void prunePeaks(idbKeyValue, known).catch(() => {})
  if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 10_000 })
  else setTimeout(run, 5000)
}
