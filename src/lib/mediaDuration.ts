/**
 * The duration of a file as the browser itself reports it. The container probes read most formats directly; this is
 * the safety net for the rest (WebM, odd containers, files the probes could not make sense of). It costs a real media
 * pipeline per file, so the importer only uses it when a probe came back empty.
 */

export interface MediaDurationOptions {
  /** Give up after this long (a file the browser cannot demux may never fire an event). Default 8 seconds. */
  timeoutMs?: number
  /** The element to ask; replaceable for tests. */
  create?: () => HTMLMediaElement
}

/** Resolves with the duration in seconds, or null when the browser cannot read the file, reports no usable length, or takes too long. */
export function measureMediaDuration(file: Blob, options: MediaDurationOptions = {}): Promise<number | null> {
  const { timeoutMs = 8000, create = () => document.createElement('audio') } = options
  return new Promise<number | null>((resolve) => {
    let element: HTMLMediaElement | null = null
    let url: string | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    let done = false

    const finish = (value: number | null): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (element) {
        element.removeEventListener('loadedmetadata', check)
        element.removeEventListener('durationchange', check)
        element.removeEventListener('error', fail)
        element.removeAttribute('src')
        element.load()
      }
      if (url) URL.revokeObjectURL(url)
      resolve(value)
    }
    // a stream of unknown length reports Infinity first and its real length in a later durationchange
    const check = (): void => {
      const d = element?.duration
      if (d !== undefined && Number.isFinite(d) && d > 0) finish(d)
    }
    const fail = (): void => finish(null)

    try {
      element = create()
      element.preload = 'metadata'
      element.addEventListener('loadedmetadata', check)
      element.addEventListener('durationchange', check)
      element.addEventListener('error', fail)
      timer = setTimeout(fail, timeoutMs)
      url = URL.createObjectURL(file)
      element.src = url
    } catch {
      finish(null)
    }
  })
}
