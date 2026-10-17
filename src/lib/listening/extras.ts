/**
 * Whether the row of loop and bookmark buttons is under the seek bar. Progressive disclosure: a song looks as it always did, and
 * the row is there when it is of use, or when the person asked for it to be there for every track (`./prefs`).
 */

/** From this length (seconds) a track is a recording to listen to in parts, not a song. */
export const LONG_RECORDING = 20 * 60

/** Whether a track of this length (0 or NaN: not known) is a long recording. A length that never ends is not a recording to keep a place in. */
export const isLongRecording = (duration: number): boolean => Number.isFinite(duration) && duration >= LONG_RECORDING

export interface ToolsContext {
  /** The person chose "always". */
  always: boolean
  chapters: number
  /** A loop is set, or its start is waiting for its end. */
  looping: boolean
  bookmarks: number
  long: boolean
}

export const showTools = (c: ToolsContext): boolean => c.always || c.chapters > 0 || c.looping || c.bookmarks > 0 || c.long
