// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { chapterAnnouncement, chapterPosition } from './speech'
import type { Chapter } from './types'

const chapters: Chapter[] = [
  { start: 0, end: 10, title: 'Prologue' },
  { start: 10, end: 20, title: 'Chapter 2' },
  { start: 20, end: 30, title: 'The Fall of Rome' },
]

describe('chapterPosition', () => {
  it('counts from one', () => {
    expect(chapterPosition(0, 12)).toBe('1 of 12')
    expect(chapterPosition(11, 12)).toBe('12 of 12')
  })
})

describe('chapterAnnouncement', () => {
  it('says which chapter begins, of how many, and what it is called', () => {
    expect(chapterAnnouncement(chapters, 0)).toBe('Chapter 1 of 3: Prologue')
    expect(chapterAnnouncement(chapters, 2)).toBe('Chapter 3 of 3: The Fall of Rome')
  })

  it('does not say a name twice when the chapter has none of its own (the reader called it "Chapter N")', () => {
    expect(chapterAnnouncement(chapters, 1)).toBe('Chapter 2 of 3')
  })

  it('still says a title that merely looks like another chapter number', () => {
    expect(chapterAnnouncement([{ start: 0, end: 5, title: 'Chapter 7' }], 0)).toBe('Chapter 1 of 1: Chapter 7')
  })

  it('says nothing before the first chapter, after the last, or for a list without chapters', () => {
    expect(chapterAnnouncement(chapters, -1)).toBe('')
    expect(chapterAnnouncement(chapters, 3)).toBe('')
    expect(chapterAnnouncement([], 0)).toBe('')
  })
})
