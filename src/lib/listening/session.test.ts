// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { memoryKv } from '../../test-utils/memorykv'
import type { Progress } from './progress'
import { ProgressService } from './progressservice'
import { LongFormSession } from './session'
import type { Moment } from './session'

const BOOK = 'book.mp3|100|1'
const SONG = 'song.mp3|10|2'
const HOUR = 3600
const T0 = 1_800_000_000_000

interface Setup {
  /** What is already kept, by track key. */
  kept?: Readonly<Record<string, Partial<Progress>>>
  /** The usual speed kept on the device; null: none kept yet. */
  usual?: number | null
}

/** A session over the real service and a memory database, with the player's hands as spies and a clock the test winds. */
async function rig({ kept = {}, usual = 1 }: Setup = {}) {
  let clock = T0
  let usualSpeed = usual
  let position = 0
  const records = Object.fromEntries(Object.entries(kept).map(([key, patch]) => [`heard:${key}`, { v: 1, at: T0 - 1000, t: null, speed: null, mode: 'auto', ...patch }]))
  const service = new ProgressService({ kv: memoryKv(records), now: () => clock })
  await service.ready()
  const port = {
    position: () => position,
    seek: vi.fn<(seconds: number) => void>(),
    setSpeed: vi.fn<(speed: number) => void>(),
    readUsualSpeed: () => usualSpeed,
    writeUsualSpeed: vi.fn((speed: number) => {
      usualSpeed = speed
    }),
    toast: vi.fn<(text: string, action: { label: string; run: () => void }) => void>(),
    now: () => clock,
  }
  const session = new LongFormSession({ store: service, port })
  return {
    session,
    service,
    port,
    advance: (ms: number) => void (clock += ms),
    /** Where the player's exact playhead is, for the moments that ask for it (a page that is closing). */
    playheadAt: (seconds: number) => void (position = seconds),
    /** The action of the first toast: the "Start over" button. */
    startOver: () => {
      const call = port.toast.mock.calls[0]
      if (!call) throw new Error('no toast was shown')
      call[1].run()
    },
  }
}

const moment = (patch: Partial<Moment> = {}): Moment => ({ key: BOOK, long: true, playing: false, time: 0, duration: 2 * HOUR, speed: 1, ...patch })
const song = (patch: Partial<Moment> = {}): Moment => moment({ key: SONG, long: false, duration: 215, ...patch })

describe('LongFormSession: taking a long recording up where it was left', () => {
  it.each([
    [600, 597, '9:57'],
    [5025, 5022, '1:23:42'],
    [5, 2, '0:02'],
  ])('a place at %d s: the playhead goes to %d s and the person is told "Resumed at %s"', async (place, to, said) => {
    const { session, port } = await rig({ kept: { [BOOK]: { t: place } } })
    session.update(moment())
    expect(port.seek.mock.calls).toEqual([[to]])
    expect(port.toast).toHaveBeenCalledTimes(1)
    expect(port.toast).toHaveBeenCalledWith(`Resumed at ${said}`, { label: 'Start over', run: expect.any(Function) })
  })

  it('does nothing for a recording with no place kept', async () => {
    const { session, port } = await rig()
    session.update(moment())
    expect(port.seek).not.toHaveBeenCalled()
    expect(port.toast).not.toHaveBeenCalled()
  })

  it('does not resume a song, and leaves the place kept for it alone', async () => {
    const { session, port, service } = await rig({ kept: { [SONG]: { t: 600 } } })
    session.update(song())
    session.update(song({ playing: true, time: 30 }))
    session.update(song({ playing: false, time: 31 }))
    expect(port.seek).not.toHaveBeenCalled()
    expect(service.get(SONG)?.t).toBe(600)
  })

  it.each([
    [2, 'the beginning'],
    [2 * HOUR - 10, 'the end'],
  ])('does not resume a place at %d s: it is %s, so the recording plays from its start', async (place) => {
    const { session, port } = await rig({ kept: { [BOOK]: { t: place } } })
    session.update(moment())
    expect(port.seek).not.toHaveBeenCalled()
    expect(port.toast).not.toHaveBeenCalled()
  })

  it('asks for the place once, not at every moment that follows', async () => {
    const { session, port } = await rig({ kept: { [BOOK]: { t: 600 } } })
    session.update(moment())
    session.update(moment({ time: 597 }))
    session.update(moment({ time: 597, playing: true }))
    session.update(moment({ time: 597.25, playing: true }))
    expect(port.seek).toHaveBeenCalledTimes(1)
    expect(port.toast).toHaveBeenCalledTimes(1)
  })

  it('does not pull back a recording whose playhead is already well on, when it is not the first of the page (a shared session has just let go of it)', async () => {
    const { session, port } = await rig({ kept: { [BOOK]: { t: 600 } } })
    session.update(song()) // the first track of the page
    session.update(moment({ time: 12.5 }))
    expect(port.seek).not.toHaveBeenCalled()
    expect(port.toast).not.toHaveBeenCalled()
  })

  it('takes up the first recording of the page though the player has already put its playhead back where it was (a reload)', async () => {
    const { session, port } = await rig({ kept: { [BOOK]: { t: 600 } } })
    session.update(moment({ time: 598 })) // the player\'s own saved position, applied before the session heard about the track
    expect(port.seek.mock.calls).toEqual([[597]])
    expect(port.toast).toHaveBeenCalledWith('Resumed at 9:57', { label: 'Start over', run: expect.any(Function) })
  })

  it('counts the first recording of the page from the start again once the session was closed and told about a track again', async () => {
    const { session, port } = await rig({ kept: { [BOOK]: { t: 600 } } })
    session.update(moment({ time: 598 }))
    session.close()
    session.update(moment({ time: 598 }))
    expect(port.seek.mock.calls).toEqual([[597], [597]])
  })

  it('"Start over" goes to the beginning and forgets the place, so the next visit starts there too', async () => {
    const { session, port, service, startOver } = await rig({ kept: { [BOOK]: { t: 600 } } })
    session.update(moment())
    startOver()
    expect(port.seek.mock.calls).toEqual([[597], [0]])
    expect(service.get(BOOK)).toBeNull()
  })

  it('"Start over" used after moving on forgets that place, and does not move the track that plays now', async () => {
    const { session, port, service, startOver } = await rig({ kept: { [BOOK]: { t: 600 } } })
    session.update(moment())
    session.update(song({ playing: true }))
    startOver()
    expect(port.seek.mock.calls).toEqual([[597]]) // only the resume; the song was not moved
    expect(service.get(BOOK)).toBeNull()
  })

  it('takes up a recording that is found to be long only once its length is known, even though it has already begun to play', async () => {
    const { session, port } = await rig({ kept: { [BOOK]: { t: 600 } } })
    session.update(moment({ long: false, duration: 0, playing: true }))
    expect(port.seek).not.toHaveBeenCalled()
    session.update(moment({ long: true, playing: true, time: 0.25 })) // started a moment ago, so it has not got anywhere
    session.update(moment({ long: true, playing: true, time: 0.5 }))
    expect(port.seek.mock.calls).toEqual([[597]]) // once, however many reports follow
  })

  it('keeps the place of a recording that was found to be long only after it began, from then on', async () => {
    const { session, service, advance } = await rig()
    session.update(moment({ long: false, duration: 0, playing: true }))
    session.update(moment({ long: true, playing: true, time: 0.25 }))
    advance(6000)
    session.update(moment({ long: true, playing: true, time: 6.25 }))
    expect(service.get(BOOK)?.t).toBe(6.25)
  })

  it('does not pull back a recording that got going before it was found to be long', async () => {
    const { session, port } = await rig({ kept: { [BOOK]: { t: 600 } } })
    session.update(song()) // the first track of the page
    session.update(moment({ long: false, duration: 0 }))
    session.update(moment({ long: false, duration: 0, playing: true, time: 6 }))
    session.update(moment({ long: true, playing: true, time: 6.25 }))
    expect(port.seek).not.toHaveBeenCalled()
  })
})

describe('LongFormSession: keeping the place', () => {
  it('writes the place every five seconds while a long recording plays, and not more often', async () => {
    const { session, service, advance } = await rig()
    session.update(moment())
    advance(1000)
    session.update(moment({ playing: true, time: 10 }))
    expect(service.get(BOOK)).toBeNull()
    advance(4000)
    session.update(moment({ playing: true, time: 14 }))
    expect(service.get(BOOK)?.t).toBe(14)
    advance(2000)
    session.update(moment({ playing: true, time: 16 }))
    expect(service.get(BOOK)?.t).toBe(14)
    advance(3000)
    session.update(moment({ playing: true, time: 19 }))
    expect(service.get(BOOK)?.t).toBe(19)
  })

  it('keeps the place the moment playing stops, without waiting for the five seconds', async () => {
    const { session, service, advance } = await rig()
    session.update(moment())
    session.update(moment({ playing: true, time: 100 }))
    advance(1000)
    session.update(moment({ playing: false, time: 100.4 }))
    expect(service.get(BOOK)?.t).toBe(100.4)
  })

  it('keeps the place of the recording it moves away from, and nothing for the track it moves to', async () => {
    const { session, service, advance } = await rig()
    session.update(moment())
    session.update(moment({ playing: true, time: 300 }))
    advance(1000)
    session.update(song({ playing: true }))
    expect(service.get(BOOK)?.t).toBe(300)
    expect(service.get(SONG)).toBeNull()
  })

  it('comes back to a recording at the place where it was left, after a song in between', async () => {
    const { session, port, advance } = await rig()
    session.update(moment())
    session.update(moment({ playing: true, time: 400 }))
    advance(1000)
    session.update(song({ playing: true }))
    advance(1000)
    session.update(moment({ playing: true }))
    expect(port.seek.mock.calls).toEqual([[397]])
    expect(port.toast).toHaveBeenCalledWith('Resumed at 6:37', { label: 'Start over', run: expect.any(Function) })
  })

  it('does not drift three seconds back each time a recording is only opened and left', async () => {
    const { session, service } = await rig({ kept: { [BOOK]: { t: 600 } } })
    session.update(moment())
    session.update(moment({ time: 597 })) // there, and never played
    session.update(song())
    expect(service.get(BOOK)?.t).toBe(600)
  })

  it('does not take a playhead that is still at the start for the place where the person stopped, while the file has not been read', async () => {
    const { session, service, advance } = await rig({ kept: { [BOOK]: { t: 600 } } })
    session.update(moment())
    session.update(moment({ playing: true, time: 0 })) // play pressed on a slow disk: nothing has moved yet
    advance(6000)
    session.update(moment({ playing: false, time: 0 }))
    session.update(song())
    expect(service.get(BOOK)?.t).toBe(600)
  })

  it('trusts the playhead again once it has reached the place, and keeps where it goes from there', async () => {
    const { session, service, advance } = await rig({ kept: { [BOOK]: { t: 600 } } })
    session.update(moment())
    session.update(moment({ playing: true, time: 0 }))
    session.update(moment({ playing: true, time: 597 })) // the file was read and the playhead put where it was left
    advance(1000)
    session.update(moment({ playing: false, time: 650 }))
    expect(service.get(BOOK)?.t).toBe(650)
  })

  it('trusts a playhead that plays on from somewhere else, when the person moved it before the file was read', async () => {
    const { session, service, advance } = await rig({ kept: { [BOOK]: { t: 600 } } })
    session.update(moment())
    session.update(moment({ playing: true, time: 100 }))
    advance(500)
    session.update(moment({ playing: true, time: 100.25 })) // it is playing on from 100: that is where the person is
    advance(1000)
    session.update(moment({ playing: false, time: 101.5 }))
    expect(service.get(BOOK)?.t).toBe(101.5)
  })

  it('forgets the place of a recording the person took back to its start', async () => {
    const { session, service, advance } = await rig({ kept: { [BOOK]: { t: 600 } } })
    session.update(moment())
    session.update(moment({ playing: true, time: 597 }))
    advance(1000)
    session.update(moment({ playing: true, time: 2 }))
    advance(1000)
    session.update(moment({ playing: false, time: 3 }))
    expect(service.get(BOOK)).toBeNull()
  })

  it('forgets the place of a recording that was heard to its end', async () => {
    const { session, service, advance } = await rig({ kept: { [BOOK]: { t: 600 } } })
    session.update(moment())
    session.update(moment({ playing: true, time: 597 }))
    advance(6000)
    session.update(moment({ playing: true, time: 7195 }))
    expect(service.get(BOOK)).toBeNull()
  })

  it('ignores a report that is not a time, and keeps the place it had', async () => {
    const { session, service, advance } = await rig({ kept: { [BOOK]: { t: 600 } } })
    session.update(moment())
    session.update(moment({ playing: true, time: 597 }))
    advance(6000)
    session.update(moment({ playing: true, time: Number.NaN }))
    advance(1000)
    session.update(moment({ playing: false, time: -4 }))
    expect(service.get(BOOK)?.t).toBe(600)
  })

  it('never keeps a place for a song', async () => {
    const { session, service, advance } = await rig()
    session.update(song())
    session.update(song({ playing: true, time: 100 }))
    advance(6000)
    session.update(song({ playing: true, time: 106 }))
    session.update(song({ playing: false, time: 106 }))
    session.update(moment())
    expect(service.get(SONG)).toBeNull()
  })

  it('keeps the exact place when the page is closing, from the player and not from the last report', async () => {
    const { session, service, playheadAt } = await rig()
    session.update(moment())
    session.update(moment({ playing: true, time: 300 }))
    playheadAt(321.25)
    session.flush()
    expect(service.get(BOOK)?.t).toBe(321.25)
  })

  it('keeps nothing when the page closes before anything was played, so the place kept is not replaced by the rewound one', async () => {
    const { session, service, playheadAt } = await rig({ kept: { [BOOK]: { t: 600 } } })
    session.update(moment())
    playheadAt(597)
    session.flush()
    expect(service.get(BOOK)?.t).toBe(600)
  })

  it('keeps the place of the recording being heard when the session is closed', async () => {
    const { session, service } = await rig()
    session.update(moment())
    session.update(moment({ playing: true, time: 300 }))
    session.close()
    expect(service.get(BOOK)?.t).toBe(300)
  })

  it('does nothing after it was closed, until it is told about a track again', async () => {
    const { session, service, playheadAt } = await rig()
    session.update(moment())
    session.update(moment({ playing: true, time: 300 }))
    session.close()
    playheadAt(500)
    session.flush()
    expect(service.get(BOOK)?.t).toBe(300)
  })
})

describe('LongFormSession: the speed', () => {
  it('plays a long recording at the speed chosen for it, and the next song at the usual speed', async () => {
    const { session, port } = await rig({ kept: { [BOOK]: { speed: 1.5 } }, usual: 1 })
    session.update(moment({ speed: 1 }))
    session.update(moment({ speed: 1.5 }))
    session.update(song({ speed: 1.5 }))
    expect(port.setSpeed.mock.calls).toEqual([[1.5], [1]])
  })

  it('plays a long recording that has no speed of its own at the usual speed, and does not take that speed for its own', async () => {
    const { session, port, service } = await rig({ usual: 1.25 })
    session.update(moment({ speed: 1.5 })) // left over from the recording before
    expect(port.setSpeed.mock.calls).toEqual([[1.25]])
    session.update(moment({ speed: 1.25 })) // the player took it: the session's own change, not the person's
    expect(service.get(BOOK)).toBeNull()
  })

  it('leaves the speed alone when it already is the one to play at', async () => {
    const { session, port } = await rig({ kept: { [BOOK]: { speed: 1.5 } } })
    session.update(moment({ speed: 1.5 }))
    expect(port.setSpeed).not.toHaveBeenCalled()
  })

  it('keeps a speed chosen on a long recording for that recording, and does not make it the usual speed', async () => {
    const { session, port, service } = await rig({ usual: 1 })
    session.update(moment({ speed: 1 }))
    session.update(moment({ speed: 1.75 }))
    expect(service.get(BOOK)?.speed).toBe(1.75)
    expect(port.writeUsualSpeed).not.toHaveBeenCalled()
    session.update(song({ speed: 1.75 }))
    expect(port.setSpeed.mock.calls).toEqual([[1]])
  })

  it('makes a speed chosen on a song the usual speed, and keeps nothing against the song', async () => {
    const { session, port, service } = await rig({ usual: 1 })
    session.update(song({ speed: 1 }))
    session.update(song({ speed: 1.25 }))
    expect(port.writeUsualSpeed.mock.calls).toEqual([[1.25]])
    expect(service.get(SONG)).toBeNull()
    session.update(moment({ speed: 1.25 })) // a recording with no speed of its own follows the usual one: already there
    expect(port.setSpeed).not.toHaveBeenCalled()
  })

  it('does not take the old speed arriving again, after it asked for another, for a choice of the person', async () => {
    const { session, port } = await rig({ usual: 1 })
    session.update(song({ speed: 1.5 })) // left over from a long recording
    expect(port.setSpeed.mock.calls).toEqual([[1]])
    session.update(song({ speed: 1.5 })) // the same render, before the player took the new speed
    session.update(song({ speed: 1 }))
    expect(port.writeUsualSpeed).not.toHaveBeenCalled()
  })

  it('takes the speed of the first track for the usual one when none is kept yet, and keeps it', async () => {
    const { session, port } = await rig({ usual: null })
    session.update(song({ speed: 1.25 }))
    expect(port.writeUsualSpeed.mock.calls).toEqual([[1.25]])
    expect(port.setSpeed).not.toHaveBeenCalled()
  })

  it('gives the usual speed back when a recording stops being a long one (the person said "never" for it)', async () => {
    const { session, port } = await rig({ kept: { [BOOK]: { speed: 1.5 } }, usual: 1 })
    session.update(moment({ speed: 1 }))
    session.update(moment({ speed: 1.5 }))
    session.update(moment({ speed: 1.5, long: false }))
    expect(port.setSpeed.mock.calls).toEqual([[1.5], [1]])
  })

  it('gives a recording its own speed once it turns out to be a long one', async () => {
    const { session, port } = await rig({ kept: { [BOOK]: { speed: 1.5 } }, usual: 1 })
    session.update(moment({ long: false, speed: 1 }))
    expect(port.setSpeed).not.toHaveBeenCalled()
    session.update(moment({ long: true, speed: 1 }))
    expect(port.setSpeed.mock.calls).toEqual([[1.5]])
  })

  it('leaves the speed to someone else while no track is its to look after (a shared session follows its host)', async () => {
    const { session, port, service } = await rig({ usual: 1 })
    session.update(moment({ key: null, long: false, speed: 1 }))
    session.update(moment({ key: null, long: false, speed: 2 }))
    expect(port.setSpeed).not.toHaveBeenCalled()
    expect(port.writeUsualSpeed).not.toHaveBeenCalled()
    expect(service.get(BOOK)).toBeNull()
  })
})
