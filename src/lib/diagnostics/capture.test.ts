import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const record = vi.fn()

beforeEach(() => {
  vi.resetModules()
  record.mockReset()
  vi.doMock('./log', () => ({ record }))
})

afterEach(() => {
  vi.doUnmock('./log')
})

const load = () => import('./capture')

/** The events the browser sends to `window`, as plain events with the fields the handlers read. */
const errorEvent = (fields: { message?: string; filename?: string; error?: unknown }): Event => Object.assign(new Event('error'), { message: '', filename: '', error: undefined, ...fields })
const rejectionEvent = (reason: unknown): Event => Object.assign(new Event('unhandledrejection'), { reason })

describe('keep and note', () => {
  it('hands a failure to the log', async () => {
    const { keep } = await load()
    const error = new Error('x')
    keep('save', error)
    await vi.waitFor(() => expect(record).toHaveBeenCalledWith('save', error))
  })

  it('hands over under the kind it was made for', async () => {
    const { note } = await load()
    const error = new Error('x')
    Promise.reject(error).catch(note('decode'))
    await vi.waitFor(() => expect(record).toHaveBeenCalledWith('decode', error))
    expect(record).toHaveBeenCalledTimes(1)
  })

  it('keeps what arrived while the log could not be fetched, and hands it over first with the next failure', async () => {
    vi.doMock('./log', () => {
      throw new Error('Failed to fetch dynamically imported module')
    })
    const { keep } = await load()
    const lost = new Error('lost')
    keep('worker', lost)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(record).not.toHaveBeenCalled()
    vi.doMock('./log', () => ({ record }))
    const found = new Error('found')
    keep('play', found)
    await vi.waitFor(() => expect(record).toHaveBeenCalledTimes(2))
    expect(record.mock.calls).toEqual([
      ['worker', lost],
      ['play', found],
    ])
  })

  it('keeps no more than a short list while the log cannot be fetched', async () => {
    vi.doMock('./log', () => {
      throw new Error('offline')
    })
    const { keep } = await load()
    for (let i = 0; i < 50; i++) keep('error', new Error(`failure ${i}`))
    await new Promise((resolve) => setTimeout(resolve, 50))
    vi.doMock('./log', () => ({ record }))
    keep('error', new Error('last'))
    await vi.waitFor(() => expect(record).toHaveBeenCalled())
    expect(record.mock.calls.length).toBeLessThanOrEqual(21)
    expect(record.mock.calls[0]?.[1]).toEqual(new Error('failure 0'))
  })
})

describe('installCapture', () => {
  it('keeps an error nobody caught', async () => {
    const { installCapture } = await load()
    const target = new EventTarget()
    installCapture(target as unknown as Window)
    const error = new TypeError('boom')
    target.dispatchEvent(errorEvent({ message: 'Uncaught TypeError: boom', error }))
    await vi.waitFor(() => expect(record).toHaveBeenCalledWith('error', error))
  })

  it('keeps the message when the browser gave no error object', async () => {
    const { installCapture } = await load()
    const target = new EventTarget()
    installCapture(target as unknown as Window)
    target.dispatchEvent(errorEvent({ message: 'Something failed', filename: 'https://example.com/assets/index-abc.js' }))
    await vi.waitFor(() => expect(record).toHaveBeenCalledWith('error', 'Something failed'))
  })

  it('keeps a promise nobody handled', async () => {
    const { installCapture } = await load()
    const target = new EventTarget()
    installCapture(target as unknown as Window)
    const reason = new RangeError('too far')
    target.dispatchEvent(rejectionEvent(reason))
    await vi.waitFor(() => expect(record).toHaveBeenCalledWith('rejection', reason))
  })

  it('keeps a rejection whatever it was rejected with', async () => {
    const { installCapture } = await load()
    const target = new EventTarget()
    installCapture(target as unknown as Window)
    target.dispatchEvent(rejectionEvent(undefined))
    target.dispatchEvent(rejectionEvent('text'))
    await vi.waitFor(() => expect(record).toHaveBeenCalledTimes(2))
  })

  it.each([
    ['a script of a browser extension', { message: 'Uncaught Error: x', filename: 'chrome-extension://abcdef/content.js', error: new Error('x') }],
    ['an extension of Firefox', { message: 'x', filename: 'moz-extension://abcdef/content.js', error: new Error('x') }],
    ['a script the browser hides', { message: 'Script error.', filename: '' }],
    ['the browser\'s remark about an observer', { message: 'ResizeObserver loop completed with undelivered notifications.' }],
    ['the older wording of that remark', { message: 'ResizeObserver loop limit exceeded' }],
  ])('leaves out %s', async (_name, fields) => {
    const { installCapture, keep } = await load()
    const target = new EventTarget()
    installCapture(target as unknown as Window)
    target.dispatchEvent(errorEvent(fields))
    const marker = new Error('marker')
    keep('error', marker) // handed over after the event: when this arrives, the event has been dealt with
    await vi.waitFor(() => expect(record).toHaveBeenCalledWith('error', marker))
    expect(record).toHaveBeenCalledTimes(1)
  })

  it('keeps a script error that did come with an error object', async () => {
    const { installCapture } = await load()
    const target = new EventTarget()
    installCapture(target as unknown as Window)
    const error = new Error('real')
    target.dispatchEvent(errorEvent({ message: 'Script error.', error }))
    await vi.waitFor(() => expect(record).toHaveBeenCalledWith('error', error))
  })

  it('stops listening when it is told to', async () => {
    const { installCapture, keep } = await load()
    const target = new EventTarget()
    const stop = installCapture(target as unknown as Window)
    stop()
    target.dispatchEvent(errorEvent({ message: 'x', error: new Error('x') }))
    target.dispatchEvent(rejectionEvent(new Error('y')))
    const marker = new Error('marker')
    keep('error', marker)
    await vi.waitFor(() => expect(record).toHaveBeenCalledWith('error', marker))
    expect(record).toHaveBeenCalledTimes(1)
  })

  it('listens to the window by default', async () => {
    const { installCapture } = await load()
    const stop = installCapture()
    const error = new Error('on the window')
    window.dispatchEvent(errorEvent({ message: 'x', error }))
    await vi.waitFor(() => expect(record).toHaveBeenCalledWith('error', error))
    stop()
  })
})
