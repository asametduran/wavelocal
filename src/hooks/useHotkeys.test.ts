import { describe, expect, it } from 'vitest'
import { isTyping } from './useHotkeys'

const input = (type: string): HTMLInputElement => Object.assign(document.createElement('input'), { type })

describe('isTyping', () => {
  it('is true where a key press goes into text', () => {
    expect(isTyping(input('text'))).toBe(true)
    expect(isTyping(input('search'))).toBe(true)
    expect(isTyping(document.createElement('textarea'))).toBe(true)
    expect(isTyping(document.createElement('select'))).toBe(true)
  })

  it('is true in an editable area', () => {
    const area = document.createElement('div')
    Object.defineProperty(area, 'isContentEditable', { value: true }) // jsdom does not implement it
    expect(isTyping(area)).toBe(true)
  })

  it('is false on a slider, which takes keys but not text, so the player shortcuts keep working there', () => {
    expect(isTyping(input('range'))).toBe(false)
  })

  it('is false on a button, on plain content, and with no target', () => {
    expect(isTyping(document.createElement('button'))).toBe(false)
    expect(isTyping(document.createElement('div'))).toBe(false)
    expect(isTyping(document.body)).toBe(false)
    expect(isTyping(null)).toBe(false)
    expect(isTyping(window)).toBe(false)
  })
})
