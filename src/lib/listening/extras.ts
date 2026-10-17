/**
 * Whether the row of loop and bookmark buttons is under the seek bar. Progressive disclosure: a song looks as it always did, and
 * the row is there when it is of use, or when the person asked for it to be there for every track (`./prefs`). What makes a
 * track a long recording is decided in `./progress` (the length the person chose, and what they said about this track).
 */

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
