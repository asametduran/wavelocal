// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { overlays } from '../overlays'
import { explainDropped, explainFailing } from './notices'

/** The dialog on screen right now, if any. */
const shown = () => overlays.snapshot().dialog
const toasts = () => overlays.snapshot().toasts

afterEach(() => {
  overlays.cancelAll()
  for (const toast of toasts()) overlays.dismissToast(toast.id)
})

describe('explainFailing', () => {
  it('says what to do when the device is out of room, and offers to try again at once', () => {
    const retryNow = vi.fn()
    explainFailing('failing', new DOMException('The quota has been exceeded.', 'QuotaExceededError'), { retryNow })
    const [toast] = toasts()
    expect(toast?.text).toContain('out of storage space')
    expect(toast?.text).toContain('Sound & tools')
    expect(toast?.action?.label).toBe('Try again')
    toast?.action?.run()
    expect(retryNow).toHaveBeenCalledTimes(1)
  })

  it('does not guess at the cause when it is not a lack of room, and says it keeps trying', () => {
    explainFailing('failing', new Error('disk'), { retryNow: vi.fn() })
    expect(toasts()[0]?.text).toBe('Your latest changes could not be saved on this device. Wavelocal keeps trying.')
  })

  it('says that saving works again when it does, without an action', () => {
    explainFailing('recovered', null, { retryNow: vi.fn() })
    expect(toasts()[0]).toMatchObject({ text: 'Saving works again.', action: null })
  })
})

describe('explainDropped', () => {
  it('tells a window that could not open the saved library that it is not saving, that the files are untouched, and offers a reload', async () => {
    const reload = vi.fn()
    const done = explainDropped('memory', 'unreadable', { reload })
    const dialog = shown()
    expect(dialog).toMatchObject({ title: 'Wavelocal is not saving', confirmLabel: 'Reload', cancelLabel: 'Not now' })
    expect(dialog?.message).toContain('could not open the library saved on this device')
    expect(dialog?.message).toContain('untouched')
    overlays.answer(dialog?.id ?? -1, { ok: true })
    await done
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('tells a window that another window took over that its changes are not saved, and offers to take over (which is a reload)', async () => {
    const reload = vi.fn()
    const done = explainDropped('taken', null, { reload })
    const dialog = shown()
    expect(dialog).toMatchObject({ title: 'Another window took over', confirmLabel: 'Use this window', cancelLabel: 'Not now' })
    expect(dialog?.message).toContain('has taken over your library')
    expect(dialog?.message).toContain('Changes made here are not saved')
    overlays.answer(dialog?.id ?? -1, { ok: true })
    await done
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('leaves a window that another window took over alone when the person is not ready to switch', async () => {
    const reload = vi.fn()
    const done = explainDropped('taken', null, { reload })
    overlays.answer(shown()?.id ?? -1, { ok: false })
    await done
    expect(reload).not.toHaveBeenCalled()
  })

  it('leaves the window as it is when the person is not ready to reload', async () => {
    const reload = vi.fn()
    const done = explainDropped('memory', 'unreadable', { reload })
    overlays.answer(shown()?.id ?? -1, { ok: false })
    await done
    expect(reload).not.toHaveBeenCalled()
  })

  it('tells a browser that keeps nothing that the library goes with the tab, with nothing to reload', async () => {
    const reload = vi.fn()
    const done = explainDropped('memory', 'unavailable', { reload })
    const dialog = shown()
    expect(dialog).toMatchObject({ title: 'Nothing can be saved here', cancelLabel: null })
    expect(dialog?.message).toContain('does not let Wavelocal keep anything')
    expect(dialog?.message).toContain('gone when this tab closes')
    overlays.answer(dialog?.id ?? -1, { ok: true })
    await done
    expect(reload).not.toHaveBeenCalled()
  })

  it('asks nothing of a window that is saving', async () => {
    await explainDropped('open', null, { reload: vi.fn() })
    await explainDropped('loading', null, { reload: vi.fn() })
    expect(shown()).toBeNull()
  })
})
