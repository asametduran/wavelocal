import { describe, expect, it, vi } from 'vitest'
import { handleBack } from './androidback'

// The rule for the hardware Back button, against the two things it can do.

const press = (event: unknown) => {
  const actions = { goBack: vi.fn(), minimize: vi.fn() }
  handleBack(event, actions)
  return actions
}

describe('handleBack', () => {
  it('goes back through the history while the WebView has an entry to go back to, and does nothing else', () => {
    const { goBack, minimize } = press({ canGoBack: true })
    expect(goBack).toHaveBeenCalledTimes(1)
    expect(minimize).not.toHaveBeenCalled()
  })

  it('sends the app to the background at the root, and does nothing else', () => {
    const { goBack, minimize } = press({ canGoBack: false })
    expect(minimize).toHaveBeenCalledTimes(1)
    expect(goBack).not.toHaveBeenCalled()
  })

  it.each<[string, unknown]>([
    ['nothing', undefined],
    ['null', null],
    ['an empty event', {}],
    ['a string', 'true'],
    ['a number', 1],
    ['an array', [true]],
    ['the text "true"', { canGoBack: 'true' }],
    ['the number 1', { canGoBack: 1 }],
    ['null', { canGoBack: null }],
    ['nothing in canGoBack', { canGoBack: undefined }],
    ['an object', { canGoBack: {} }],
  ])('takes the road that cannot do harm for %s: only the background', (_name, event) => {
    const { goBack, minimize } = press(event)
    expect(minimize).toHaveBeenCalledTimes(1)
    expect(goBack).not.toHaveBeenCalled()
  })

  it('ignores whatever else the event carries', () => {
    expect(press({ canGoBack: true, extra: 'x' }).goBack).toHaveBeenCalledTimes(1)
    expect(press({ extra: 'x', canGoBack: false }).minimize).toHaveBeenCalledTimes(1)
  })

  it('does exactly one of the two for every press, whatever the event', () => {
    const events: unknown[] = [undefined, null, 0, 1, '', 'x', true, false, [], {}, { canGoBack: true }, { canGoBack: false }, { canGoBack: 'yes' }, { canGoBack: [] }]
    for (const event of events) {
      const { goBack, minimize } = press(event)
      expect(goBack.mock.calls.length + minimize.mock.calls.length, JSON.stringify(event)).toBe(1)
    }
  })
})
