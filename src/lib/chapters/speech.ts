import type { Chapter } from './types'

/** The words for chapters, in one place: what the row under the seek bar shows and what a screen reader is told. */

/** "3 of 12": where chapter `index` (counted from 0) is among `count`. */
export const chapterPosition = (index: number, count: number): string => `${index + 1} of ${count}`

/**
 * What is said when a chapter begins: "Chapter 3 of 12: The Fall of Rome". A chapter the file gave no title is called
 * "Chapter N" by the reader (see `normalizeChapters`), and saying that twice would be noise, so only its place is said.
 */
export function chapterAnnouncement(chapters: readonly Chapter[], index: number): string {
  const chapter = chapters[index]
  if (!chapter) return ''
  const where = `Chapter ${index + 1} of ${chapters.length}`
  return chapter.title === `Chapter ${index + 1}` ? where : `${where}: ${chapter.title}`
}
