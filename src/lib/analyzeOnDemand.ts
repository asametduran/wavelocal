import type { Analysis } from './analyze'

/**
 * The analysis (container probes, tag readers) is a sizeable piece of code that only runs when files are imported, so
 * it is a chunk of its own, fetched the first time it is needed instead of weighing down the start of the app.
 */
export async function analyzeOnDemand(file: Blob, { fallbackDuration = true }: { fallbackDuration?: boolean } = {}): Promise<Analysis> {
  const { analyzeFile } = await import('./analyze')
  if (!fallbackDuration) return analyzeFile(file)
  // for files no probe could read the length of, the browser itself is asked (a media element per file, so it is a last resort)
  const { measureMediaDuration } = await import('./mediaDuration')
  return analyzeFile(file, { mediaDuration: (f) => measureMediaDuration(f) })
}
