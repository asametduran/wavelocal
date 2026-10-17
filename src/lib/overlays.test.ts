import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OverlayStore } from './overlays'

let store: OverlayStore
beforeEach(() => {
  store = new OverlayStore()
})
afterEach(() => vi.useRealTimers())

describe('confirm', () => {
  it('shows a dialog and resolves true when it is confirmed', async () => {
    const answer = store.confirm({ title: 'Remove everything?', message: 'This cannot be undone.', confirmLabel: 'Remove', danger: true })
    const dialog = store.snapshot().dialog
    expect(dialog).toMatchObject({ title: 'Remove everything?', message: 'This cannot be undone.', confirmLabel: 'Remove', cancelLabel: 'Cancel', danger: true, field: null })
    store.answer(dialog?.id ?? -1, { ok: true })
    await expect(answer).resolves.toBe(true)
    expect(store.snapshot().dialog).toBeNull()
  })

  it('resolves false when it is cancelled', async () => {
    const answer = store.confirm({ title: 'Sure?' })
    store.answer(store.snapshot().dialog?.id ?? -1, { ok: false })
    await expect(answer).resolves.toBe(false)
  })

  it('fills in sensible defaults', () => {
    void store.confirm({ title: 'Sure?' })
    expect(store.snapshot().dialog).toMatchObject({ message: '', details: [], confirmLabel: 'OK', cancelLabel: 'Cancel', danger: false })
  })
})

describe('prompt', () => {
  it('resolves with the text that was entered', async () => {
    const answer = store.prompt({ title: 'New playlist', label: 'Name', value: 'Mix', confirmLabel: 'Create' })
    const dialog = store.snapshot().dialog
    expect(dialog?.field).toEqual({ label: 'Name', value: 'Mix', placeholder: '', maxLength: 200 })
    store.answer(dialog?.id ?? -1, { ok: true, text: 'Road Trip' })
    await expect(answer).resolves.toBe('Road Trip')
  })

  it('resolves null when it is cancelled, however much was typed', async () => {
    const answer = store.prompt({ title: 'Name', label: 'Name' })
    store.answer(store.snapshot().dialog?.id ?? -1, { ok: false, text: 'ignored' })
    await expect(answer).resolves.toBeNull()
  })

  it('resolves the empty text when it is confirmed with nothing entered', async () => {
    const answer = store.prompt({ title: 'Name', label: 'Name' })
    store.answer(store.snapshot().dialog?.id ?? -1, { ok: true })
    await expect(answer).resolves.toBe('')
  })

  it('cuts what is entered to the length it allows', async () => {
    const answer = store.prompt({ title: 'Name', label: 'Name', maxLength: 5 })
    store.answer(store.snapshot().dialog?.id ?? -1, { ok: true, text: 'abcdefgh' })
    await expect(answer).resolves.toBe('abcde')
  })
})

describe('notice', () => {
  it('has only an OK button and resolves when it is closed', async () => {
    const closed = store.notice({ title: 'Imported', message: '12 of 14 tracks found.', details: ['gone/one.mp3', 'gone/two.mp3'] })
    const dialog = store.snapshot().dialog
    expect(dialog).toMatchObject({ cancelLabel: null, confirmLabel: 'OK', details: ['gone/one.mp3', 'gone/two.mp3'] })
    store.answer(dialog?.id ?? -1, { ok: true })
    await expect(closed).resolves.toBeUndefined()
  })
})

describe('the queue of dialogs', () => {
  it('shows one at a time, in the order they were asked', async () => {
    const first = store.confirm({ title: 'First' })
    const second = store.confirm({ title: 'Second' })
    expect(store.snapshot().dialog?.title).toBe('First')
    store.answer(store.snapshot().dialog?.id ?? -1, { ok: true })
    await expect(first).resolves.toBe(true)
    expect(store.snapshot().dialog?.title).toBe('Second')
    store.answer(store.snapshot().dialog?.id ?? -1, { ok: false })
    await expect(second).resolves.toBe(false)
    expect(store.snapshot().dialog).toBeNull()
  })

  it('ignores an answer for a dialog that is not there, and answers each dialog once', async () => {
    const answer = store.confirm({ title: 'Once' })
    const id = store.snapshot().dialog?.id ?? -1
    store.answer(id + 99, { ok: true })
    expect(store.snapshot().dialog?.id).toBe(id)
    store.answer(id, { ok: true })
    store.answer(id, { ok: false })
    await expect(answer).resolves.toBe(true)
  })

  it('cancels everything that is waiting when the dialogs cannot be shown', async () => {
    const a = store.confirm({ title: 'A' })
    const b = store.prompt({ title: 'B', label: 'B' })
    const c = store.notice({ title: 'C' })
    store.cancelAll()
    await expect(a).resolves.toBe(false)
    await expect(b).resolves.toBeNull()
    await expect(c).resolves.toBeUndefined()
    expect(store.snapshot().dialog).toBeNull()
  })
})

describe('snapshots and subscribers', () => {
  it('hands out a new snapshot when something changes and the same one when nothing did', () => {
    const before = store.snapshot()
    expect(store.snapshot()).toBe(before)
    void store.confirm({ title: 'x' })
    expect(store.snapshot()).not.toBe(before)
  })

  it('tells subscribers about every change until they unsubscribe', () => {
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)
    void store.confirm({ title: 'x' })
    store.toast('hello')
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
    store.toast('again')
    expect(listener).toHaveBeenCalledTimes(2)
  })
})

describe('toasts', () => {
  it('shows a message and returns its id', () => {
    const id = store.toast('Saved')
    expect(store.snapshot().toasts).toEqual([{ id, text: 'Saved', action: null, ms: 4500 }])
  })

  it('stays longer when it offers an action, and can stay until dismissed', () => {
    store.toast('Deleted', { action: { label: 'Undo', run: () => {} } })
    store.toast('Pinned', { ms: 0 })
    const [withAction, pinned] = store.snapshot().toasts
    expect(withAction?.ms).toBe(9000)
    expect(pinned?.ms).toBe(0)
  })

  it('keeps the newest few, dropping the oldest', () => {
    for (const text of ['one', 'two', 'three', 'four']) store.toast(text)
    expect(store.snapshot().toasts.map((t) => t.text)).toEqual(['two', 'three', 'four'])
  })

  it('shows a repeated message once, as the newest', () => {
    store.toast('Same')
    store.toast('Other')
    const again = store.toast('Same')
    expect(store.snapshot().toasts.map((t) => t.text)).toEqual(['Other', 'Same'])
    expect(store.snapshot().toasts.at(-1)?.id).toBe(again)
  })

  it('trims the text, caps its length, and ignores nothing-to-say', () => {
    expect(store.toast('   ')).toBe(-1)
    expect(store.snapshot().toasts).toEqual([])
    store.toast(`  ${'x'.repeat(2000)}  `)
    expect(store.snapshot().toasts[0]?.text).toHaveLength(300)
  })

  it('goes away when dismissed, and dismissing what is not there does nothing', () => {
    const id = store.toast('Bye')
    store.dismissToast(id + 5)
    expect(store.snapshot().toasts).toHaveLength(1)
    store.dismissToast(id)
    expect(store.snapshot().toasts).toEqual([])
  })

  it('runs its action once and goes away', () => {
    const run = vi.fn()
    const id = store.toast('Deleted', { action: { label: 'Undo', run } })
    store.runToastAction(id)
    store.runToastAction(id)
    expect(run).toHaveBeenCalledTimes(1)
    expect(store.snapshot().toasts).toEqual([])
  })

  it('finds the newest toast that can be undone', () => {
    expect(store.latestAction()).toBeNull()
    store.toast('Plain')
    const older = store.toast('Older', { action: { label: 'Undo', run: () => {} } })
    expect(store.latestAction()?.id).toBe(older)
    const newer = store.toast('Newer', { action: { label: 'Undo', run: () => {} } })
    expect(store.latestAction()?.id).toBe(newer)
  })

  it('survives an action that throws: it still goes away', () => {
    const id = store.toast('Oops', {
      action: {
        label: 'Undo',
        run: () => {
          throw new Error('boom')
        },
      },
    })
    expect(() => store.runToastAction(id)).not.toThrow()
    expect(store.snapshot().toasts).toEqual([])
  })
})
