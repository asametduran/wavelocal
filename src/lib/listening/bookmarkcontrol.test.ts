// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { MAX_BOOKMARKS, MAX_LABEL } from './bookmarks'
import { deleteMark, markHere, renameMark } from './bookmarkcontrol'
import type { MarkPlayer } from './bookmarkcontrol'
import { ListeningService } from './service'
import type { Bookmark } from './types'
import { overlays } from '../overlays'
import { memoryKv } from '../../test-utils/memorykv'

const KEY = 'talk.mp3|5000|1'
const mark = (t: number, label = `at ${t}`, id = `id${t}`): Bookmark => ({ id, t, label, at: 1 })

/** A service with the track's bookmarks loaded, and a player that is at `at` seconds of a track `duration` seconds long. */
async function rig(at = 62, duration = 600, stored: readonly Bookmark[] = []) {
  const kv = memoryKv(stored.length ? { [`listen:${KEY}`]: { v: 1, at: 1, bookmarks: stored } } : {})
  let n = 0
  const service = new ListeningService({ kv, now: () => 1, newId: () => `new${++n}` })
  service.want({ key: KEY })
  await new Promise((resolve) => setTimeout(resolve, 0))
  const player: MarkPlayer = { current: { key: KEY, duration: 600 }, position: () => at, duration }
  return { service, player, kv }
}

const toasts = () => overlays.snapshot().toasts
const saying = (): string[] => toasts().map((t) => t.text)
const bookmarks = (service: ListeningService): readonly Bookmark[] => {
  const state = service.getState(KEY)
  return state.status === 'ready' ? state.bookmarks : []
}

afterEach(() => {
  for (const toast of toasts()) overlays.dismissToast(toast.id)
  overlays.cancelAll()
})

describe('markHere', () => {
  it('bookmarks where the playhead is, and says what it made and where', async () => {
    const { service, player } = await rig(62)
    markHere(service, player)
    expect(bookmarks(service)).toEqual([{ id: 'new1', t: 62, label: 'Bookmark 1', at: 1 }])
    expect(saying()).toEqual(['Bookmark 1 at 1:02'])
  })

  it('offers to name it right away', async () => {
    const { service, player } = await rig(62)
    markHere(service, player)
    expect(toasts()[0]?.action?.label).toBe('Rename')
  })

  it('says that a place is marked already, names the bookmark that is there, and adds nothing', async () => {
    const { service, player } = await rig(100.2, 600, [mark(100, 'The key scene')])
    markHere(service, player)
    expect(bookmarks(service)).toHaveLength(1)
    expect(saying()).toEqual(['Already marked: The key scene at 1:40'])
  })

  it('says how many a track holds when it is full', async () => {
    const { service, player } = await rig(399, 600, Array.from({ length: MAX_BOOKMARKS }, (_, i) => mark(i * 2)))
    markHere(service, player)
    expect(saying()).toEqual([`A track holds at most ${MAX_BOOKMARKS} bookmarks. Delete one to make room.`])
  })

  it('asks for a moment when the bookmarks of the track have not been read yet', async () => {
    const kv = memoryKv()
    const service = new ListeningService({ kv, now: () => 1, newId: () => 'x' }) // never asked for the track
    markHere(service, { current: { key: KEY, duration: 600 }, position: () => 5, duration: 600 })
    expect(saying()).toEqual(['The bookmarks of this track are not ready yet. Try again in a moment.'])
  })

  it('does nothing, and says nothing, when no track is playing', async () => {
    const { service } = await rig()
    markHere(service, { current: null, position: () => 5, duration: 0 })
    expect(saying()).toEqual([])
  })

  it('says so when the playhead is not at a place in the track', async () => {
    const { service, player } = await rig(Number.NaN)
    markHere(service, player)
    expect(saying()).toEqual(['That place is not in this track.'])
    expect(bookmarks(service)).toEqual([])
  })

  it('measures against the length the player has, and the library’s when the player does not know it yet', async () => {
    const early = await rig(590, 0) // the file has not been read: the library says 600 s
    markHere(early.service, early.player)
    expect(bookmarks(early.service)).toHaveLength(1)
    const late = await rig(590, 300) // the player knows better
    markHere(late.service, late.player)
    expect(bookmarks(late.service)).toHaveLength(0)
  })
})

describe('renameMark', () => {
  it('asks for a name with the present one in the field, and keeps what is typed', async () => {
    const { service } = await rig(0, 600, [mark(10, 'Old name')])
    const done = renameMark(service, KEY, mark(10, 'Old name'))
    const dialog = overlays.snapshot().dialog
    expect(dialog?.title).toBe('Rename bookmark')
    expect(dialog?.field).toMatchObject({ label: 'Bookmark name', value: 'Old name', maxLength: MAX_LABEL })
    overlays.answer(dialog?.id ?? -1, { ok: true, text: '  New name ' })
    await done
    expect(bookmarks(service)[0]?.label).toBe('New name')
    expect(saying()).toEqual([])
  })

  it('changes nothing when the question is cancelled', async () => {
    const { service } = await rig(0, 600, [mark(10, 'Old name')])
    const done = renameMark(service, KEY, mark(10, 'Old name'))
    overlays.answer(overlays.snapshot().dialog?.id ?? -1, { ok: false })
    await done
    expect(bookmarks(service)[0]?.label).toBe('Old name')
    expect(saying()).toEqual([])
  })

  it('says that a bookmark needs a name when the answer is nothing, and keeps the old one', async () => {
    const { service } = await rig(0, 600, [mark(10, 'Old name')])
    const done = renameMark(service, KEY, mark(10, 'Old name'))
    overlays.answer(overlays.snapshot().dialog?.id ?? -1, { ok: true, text: '   ' })
    await done
    expect(bookmarks(service)[0]?.label).toBe('Old name')
    expect(saying()).toEqual(['A bookmark needs a name.'])
  })

  it('says so when the bookmark was deleted while the question was open', async () => {
    const { service } = await rig(0, 600, [mark(10, 'Old name')])
    const done = renameMark(service, KEY, mark(10, 'Old name'))
    service.remove(KEY, 'id10')
    overlays.answer(overlays.snapshot().dialog?.id ?? -1, { ok: true, text: 'Too late' })
    await done
    expect(saying()).toEqual(['That bookmark is no longer there.'])
  })

  it('is what the Rename on the toast of a new bookmark does', async () => {
    const { service, player } = await rig(62)
    markHere(service, player)
    const toast = toasts()[0]
    overlays.runToastAction(toast?.id ?? -1)
    const dialog = overlays.snapshot().dialog
    expect(dialog?.field?.value).toBe('Bookmark 1')
    overlays.answer(dialog?.id ?? -1, { ok: true, text: 'Intro' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(bookmarks(service)[0]?.label).toBe('Intro')
  })
})

describe('deleteMark', () => {
  it('deletes the bookmark and offers to bring it back', async () => {
    const { service } = await rig(0, 600, [mark(10, 'Intro'), mark(50, 'Outro')])
    deleteMark(service, KEY, mark(10, 'Intro'))
    expect(bookmarks(service).map((b) => b.label)).toEqual(['Outro'])
    expect(saying()).toEqual(['Deleted bookmark “Intro”'])
    expect(toasts()[0]?.action?.label).toBe('Undo')
  })

  it('brings it back, in its place, with the Undo', async () => {
    const { service } = await rig(0, 600, [mark(10, 'Intro'), mark(50, 'Outro')])
    deleteMark(service, KEY, mark(10, 'Intro'))
    overlays.runToastAction(toasts()[0]?.id ?? -1)
    expect(bookmarks(service).map((b) => b.label)).toEqual(['Intro', 'Outro'])
  })

  it('says so, instead of failing quietly, when the place has been marked again since and the Undo cannot be done', async () => {
    const { service, player } = await rig(10.2, 600, [mark(10, 'Intro')])
    deleteMark(service, KEY, mark(10, 'Intro'))
    const undo = toasts()[0]?.id ?? -1
    markHere(service, player) // a new bookmark 0.2 s from the old place
    overlays.runToastAction(undo)
    expect(saying()).toContain('Another bookmark was made at that place since, so “Intro” could not come back.')
    expect(bookmarks(service)).toHaveLength(1)
  })

  it('says nothing for a bookmark that is not there', async () => {
    const { service } = await rig(0, 600, [mark(10, 'Intro')])
    deleteMark(service, KEY, mark(99, 'Ghost'))
    expect(saying()).toEqual([])
    expect(bookmarks(service)).toHaveLength(1)
  })
})
