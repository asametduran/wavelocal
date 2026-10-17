/** Chapters of a long recording. Type-only (no runtime code), so the start-up code and the tests can import it freely. */

/** One chapter: a named stretch of the file. The chapters of a file follow each other and cover it from the first one's start. */
export interface Chapter {
  /** Seconds from the start of the file. */
  start: number
  /** Seconds: where the next chapter starts, or the end of the file for the last one (its own start if the length is not known). */
  end: number
  title: string
}

/** What a source of chapters (ID3 frames, an MP4 atom, Vorbis comments) hands over: unchecked, in no particular order. */
export interface RawChapter {
  /** Seconds. */
  start: number
  title: string
}

/** What is kept for a track, under `chapters:<track id>`; an empty list means "looked, and there are none". */
export interface ChaptersRecord {
  v: 1
  chapters: Chapter[]
}
