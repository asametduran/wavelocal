import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import RootBoundary from './RootBoundary'
import type { RecoveryPorts } from './RootBoundary'

const mocks = vi.hoisted(() => ({ keep: vi.fn(), silenceAudio: vi.fn() }))
vi.mock('../lib/diagnostics/capture', () => ({ keep: mocks.keep, loadLog: vi.fn() }))
vi.mock('../lib/engine', () => ({ silenceAudio: mocks.silenceAudio }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SECRET = 'render failed at "Zebra Quartet.mp3"'

function Thrower({ when }: { when: boolean }) {
  if (when) throw new Error(SECRET)
  return <p>the player</p>
}

let container: HTMLElement
let root: Root

beforeEach(() => {
  mocks.keep.mockReset()
  mocks.silenceAudio.mockReset()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  vi.spyOn(console, 'error').mockImplementation(() => {}) // React reports a caught render error, which is what these tests cause
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

function mount(ports: Partial<RecoveryPorts> = {}, throws = true): void {
  act(() => root.render(<RootBoundary ports={ports}><Thrower when={throws} /></RootBoundary>))
}
const button = (name: string): HTMLButtonElement => {
  const found = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === name)
  if (!found) throw new Error(`no button named ${name}; there are ${[...container.querySelectorAll('button')].map((b) => b.textContent).join(', ')}`)
  return found
}
const click = (el: HTMLElement): void => act(() => el.click())
/** Click a button whose handler is async, and let its promises settle. */
const clickAsync = async (el: HTMLElement): Promise<void> => {
  await act(async () => {
    el.click()
  })
}

describe('RootBoundary', () => {
  it('shows its children while nothing is wrong', () => {
    mount({}, false)
    expect(container.textContent).toBe('the player')
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it('shows a recovery screen in plain words when a child throws', () => {
    mount()
    expect(container.querySelector('h1')?.textContent).toBe('Wavelocal stopped working')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Your music and playlists are safe on this device')
    expect([...container.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Reload', 'Start fresh…', 'Copy details'])
    expect(container.textContent).not.toContain('the player')
  })

  it('does not put what the error said on the screen', () => {
    mount()
    expect(container.textContent).not.toContain('Zebra')
    expect(container.textContent).not.toContain(SECRET)
  })

  it('puts the focus on Reload', () => {
    mount()
    expect(document.activeElement).toBe(button('Reload'))
  })

  it('stops the sound and hands the error to the log', () => {
    mount()
    expect(mocks.silenceAudio).toHaveBeenCalledTimes(1)
    expect(mocks.keep).toHaveBeenCalledTimes(1)
    expect(mocks.keep.mock.calls[0]?.[0]).toBe('boundary')
    expect((mocks.keep.mock.calls[0]?.[1] as Error).message).toBe(SECRET)
  })

  it('reloads when asked to', () => {
    const reload = vi.fn()
    mount({ reload })
    click(button('Reload'))
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('asks once more before it starts fresh, says what that keeps and forgets, and lets the person back out', () => {
    const startFresh = vi.fn()
    mount({ startFresh })
    click(button('Start fresh…'))
    expect(container.textContent).toContain('keeps your music and playlists')
    expect(container.textContent).toContain('forgets your settings, where you were and what was queued')
    expect(startFresh).not.toHaveBeenCalled()
    click(button('Cancel'))
    expect(container.textContent).not.toContain('keeps your music and playlists')
    click(button('Start fresh…'))
    click(button('Start fresh'))
    expect(startFresh).toHaveBeenCalledTimes(1)
  })

  it('copies the details the log gives, for the error that was caught, and shows nothing else', async () => {
    const details = vi.fn().mockResolvedValue('THE REPORT')
    const copy = vi.fn().mockResolvedValue(undefined)
    mount({ details, copy })
    await clickAsync(button('Copy details'))
    expect(details).toHaveBeenCalledTimes(1)
    expect((details.mock.calls[0]?.[0] as Error).message).toBe(SECRET)
    expect(copy).toHaveBeenCalledWith('THE REPORT')
    expect(container.querySelector('textarea')).toBeNull()
  })

  it('shows the details to select and copy by hand when the browser will not copy them', async () => {
    const copy = vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError'))
    mount({ details: async () => 'THE REPORT', copy })
    await clickAsync(button('Copy details'))
    const box = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Details"]')
    expect(box?.value).toBe('THE REPORT')
    expect(box?.readOnly).toBe(true)
  })

  it('copies the name of the error and nothing else when the details cannot be made', async () => {
    const copy = vi.fn().mockResolvedValue(undefined)
    const reload = vi.fn()
    mount({ reload, copy, details: () => Promise.reject(new Error('no log')) })
    await clickAsync(button('Copy details'))
    expect(copy).toHaveBeenCalledTimes(1)
    expect(copy.mock.calls[0]?.[0]).toBe('Wavelocal error report\nError\nThe log could not be loaded, so nothing else is included.')
    click(button('Reload'))
    expect(reload).toHaveBeenCalledTimes(1) // and the other buttons still work
  })
})
