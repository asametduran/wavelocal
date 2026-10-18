/**
 * A cheap, synchronous guess from the name and declared type: could this possibly be WAV or FLAC? The resolver asks it for every
 * track at start-up, and the answer decides whether the (much larger) sniffing and decoding code is needed at all, so it lives
 * apart from `sniff.ts`, which reads bytes and reaches the WAV parser.
 */
export function mightBeLossless(file: { name?: string; type?: string }): boolean {
  return /\.(wav|wave|flac|fla)$/i.test(file.name ?? '') || /^audio\/(x-)?(wav|wave|vnd\.wave|flac)$/i.test(file.type ?? '')
}
