import { describe, expect, it } from 'vitest'
import { clearedMessage, queuedMessage } from './queuemessages'

describe('queuedMessage', () => {
  it('names the track when one is queued to play next or last', () => {
    expect(queuedMessage('next', 1, 'Help!')).toBe('Playing next: Help!')
    expect(queuedMessage('last', 1, 'Help!')).toBe('Added to the queue: Help!')
  })

  it('counts the tracks when several are queued', () => {
    expect(queuedMessage('next', 12, 'Abbey Road')).toBe('12 tracks will play next')
    expect(queuedMessage('last', 12, 'Abbey Road')).toBe('Added 12 tracks to the queue')
  })

  it('shortens a very long name', () => {
    const message = queuedMessage('next', 1, 'x'.repeat(200))
    expect(message.length).toBeLessThan(90)
    expect(message.endsWith('…')).toBe(true)
  })

  it('has nothing to say when nothing was queued', () => {
    expect(queuedMessage('next', 0, 'x')).toBe('')
    expect(queuedMessage('last', 0, 'x')).toBe('')
  })
})

describe('clearedMessage', () => {
  it('says how many tracks were taken out of the queue', () => {
    expect(clearedMessage(1)).toBe('Cleared 1 queued track')
    expect(clearedMessage(7)).toBe('Cleared 7 queued tracks')
  })

  it('has nothing to say for an empty queue', () => {
    expect(clearedMessage(0)).toBe('')
  })
})
