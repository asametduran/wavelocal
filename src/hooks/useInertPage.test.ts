import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { holdPageInert } from './useInertPage'

let root: HTMLElement

beforeEach(() => {
  root = document.createElement('div')
  root.id = 'root'
  document.body.append(root)
})
afterEach(() => root.remove())

describe('holdPageInert', () => {
  it('makes the page inert until it is let go', () => {
    const release = holdPageInert()
    expect(root.hasAttribute('inert')).toBe(true)
    release()
    expect(root.hasAttribute('inert')).toBe(false)
  })

  it('keeps the page inert while any dialog is still open, whichever closes first', () => {
    const first = holdPageInert()
    const second = holdPageInert()
    first()
    expect(root.hasAttribute('inert')).toBe(true) // a question closed under the chapter list: the list is still open
    second()
    expect(root.hasAttribute('inert')).toBe(false)
  })

  it('counts a dialog once however many times it lets go', () => {
    const first = holdPageInert()
    const second = holdPageInert()
    first()
    first()
    expect(root.hasAttribute('inert')).toBe(true)
    second()
    expect(root.hasAttribute('inert')).toBe(false)
  })

  it('is harmless when there is no page element', () => {
    root.remove()
    expect(() => holdPageInert()()).not.toThrow()
  })
})
