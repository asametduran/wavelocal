import { looksLikeWav, parseWav } from './wav'

/**
 * Decides whether a file needs the JavaScript decoders. Filenames and MIME types lie, so the container is
 * identified from the first bytes; "can the browser play it?" combines `canPlayType` with what is known about
 * which WAV flavours browsers refuse.
 */

export type Container = 'wav' | 'flac' | 'other'

/** Enough bytes to see the container signature and a WAV `fmt ` chunk after a few small chunks. */
export const SNIFF_BYTES = 4096

const text = (b: Uint8Array, o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n))

/** True for a FLAC stream, with or without a leading ID3v2 tag. (Kept here so sniffing never pulls in the whole decoder.) */
export function looksLikeFlac(b: Uint8Array): boolean {
  let offset = 0
  if (b.length >= 10 && text(b, 0, 3) === 'ID3') {
    const size = ((b[6] ?? 0) << 21) | ((b[7] ?? 0) << 14) | ((b[8] ?? 0) << 7) | (b[9] ?? 0)
    offset = 10 + size + ((b[5] ?? 0) & 0x10 ? 10 : 0)
  }
  return b.length >= offset + 4 && text(b, offset, 4) === 'fLaC'
}

/** Identify WAV / FLAC from the start of a file. */
export function sniffContainer(head: Uint8Array): Container {
  if (looksLikeWav(head)) return 'wav'
  if (looksLikeFlac(head)) return 'flac'
  return 'other'
}

/** Read the head of a Blob and identify it. A FLAC stream behind a large ID3v2 tag needs a second, larger read. */
export async function sniffBlob(blob: Blob): Promise<{ container: Container; head: Uint8Array }> {
  const head = new Uint8Array(await blob.slice(0, SNIFF_BYTES).arrayBuffer())
  const direct = sniffContainer(head)
  if (direct !== 'other') return { container: direct, head }
  if (head.length >= 10 && head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) {
    const size = ((head[6] ?? 0) << 21) | ((head[7] ?? 0) << 14) | ((head[8] ?? 0) << 7) | (head[9] ?? 0)
    const wider = new Uint8Array(await blob.slice(0, Math.min(blob.size, 10 + size + 20)).arrayBuffer())
    return { container: sniffContainer(wider), head: wider }
  }
  return { container: 'other', head }
}

/** A cheap, synchronous guess from the name and declared type: could this possibly be WAV or FLAC? */
export function mightBeLossless(file: { name?: string; type?: string }): boolean {
  return /\.(wav|wave|flac|fla)$/i.test(file.name ?? '') || /^audio\/(x-)?(wav|wave|vnd\.wave|flac)$/i.test(file.type ?? '')
}

const MIME: Record<Exclude<Container, 'other'>, readonly string[]> = {
  wav: ['audio/wav', 'audio/x-wav', 'audio/wave'],
  flac: ['audio/flac', 'audio/x-flac'],
}

type CanPlay = Pick<HTMLMediaElement, 'canPlayType'>

/** Does the browser claim to play this container at all? ('maybe' and 'probably' both count.) */
export function browserPlaysContainer(container: Container, element: CanPlay | null = typeof Audio === 'undefined' ? null : new Audio()): boolean {
  if (container === 'other') return true
  if (!element) return true // nothing to ask: assume yes and let a playback error trigger the fallback
  return MIME[container].some((type) => element.canPlayType(type) !== '')
}

/**
 * WAV variants that are legal but that browsers often reject: 64-bit float, RF64, and A-law/mu-law.
 * (Everything else is left to the browser; a playback error still triggers the fallback.)
 */
export function wavNeedsDecoder(head: Uint8Array): boolean {
  try {
    const info = parseWav(head)
    return info.rf64 || info.encoding === 'alaw' || info.encoding === 'mulaw' || (info.encoding === 'float' && info.bitsPerSample === 64)
  } catch {
    return false // let the browser report its own error; the fallback will give a precise one
  }
}

/** The pre-playback decision: is the JavaScript decoder needed before the browser even tries? */
export function needsDecoder(container: Container, head: Uint8Array, element?: CanPlay | null): boolean {
  if (container === 'other') return false
  if (!browserPlaysContainer(container, element)) return true
  return container === 'wav' && wavNeedsDecoder(head)
}
