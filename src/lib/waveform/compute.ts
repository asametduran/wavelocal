import { skipId3v2 } from '../audio/probe/id3'
import { sniffBlob } from '../audio/sniff'
import { blobSource } from '../audio/source'
import type { AudioContainer } from '../audio/probe/types'
import { peaksFromWhole, peaksFromWindows } from './native'
import type { DecodeFn } from './native'
import { planPeaks, planWindows } from './plan'
import type { PeaksTarget } from './service'
import type { Peaks, PeaksRecord } from './types'

/** The two things that really measure audio, passed in so that choosing between them is tested without a browser. */
export interface ComputeDeps {
  /** Measure a WAV or FLAC file off the main thread (the worker). */
  lossless(file: Blob, signal: AbortSignal): Promise<Peaks>
  /** The browser's decoder. */
  decode: DecodeFn
}

/** What `container` to plan with: the one the import probe stored with the track, or what the first bytes of the file say. */
async function containerOf(target: PeaksTarget): Promise<AudioContainer | null> {
  const stored = target.format?.container
  if (stored) return stored
  const { container } = await sniffBlob(target.file) // a track imported before the probes existed
  return container === 'other' ? null : container
}

/** Measure a track the way `planPeaks` says suits its format and length. */
export async function measureTrack(target: PeaksTarget, signal: AbortSignal, deps: ComputeDeps): Promise<PeaksRecord> {
  const { file, duration, format } = target
  const plan = planPeaks({ container: await containerOf(target), size: file.size, duration, sampleRate: format?.sampleRate ?? 0, channels: format?.channels ?? 0 })
  switch (plan.method) {
    case 'none':
      return { v: 1, none: plan.why }
    case 'lossless':
      return deps.lossless(file, signal)
    case 'sliced': {
      const audioStart = await skipId3v2(blobSource(file))
      return peaksFromWindows(file, planWindows(file.size, audioStart, duration), deps.decode, { duration, signal })
    }
    case 'whole':
      return peaksFromWhole(file, deps.decode, { duration, signal })
  }
}
