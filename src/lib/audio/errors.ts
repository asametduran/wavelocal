/**
 * Why decoding failed: the format is not handled, the data is damaged, or it ends early. A module of its own, tiny on purpose: the
 * player and the resolver that decides what an `<audio>` element is given need the class at start-up, and `pcm.ts`, which used to
 * hold it, is the whole sample-conversion code of the lossless decoders (and reaches the WAV parser), which they do not.
 */
export class AudioDecodeError extends Error {
  constructor(
    message: string,
    readonly code: 'unsupported' | 'corrupt' | 'truncated' | 'aborted',
  ) {
    super(message)
    this.name = 'AudioDecodeError'
  }
}
