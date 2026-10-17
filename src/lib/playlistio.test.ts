import { beforeEach, describe, expect, it, vi } from 'vitest'
import { overlays } from './overlays'
import { exportPlaylist, importPlaylistFiles } from './playlistio'
import type { Playlist, Track } from '../types'

const track = (id: string, folder: string, file: string, title: string, artist = 'Band', duration = 100): Track => ({ id, path: folder, file: { name: file }, title, artist, duration }) as unknown as Track
const library = [track('t1', 'Music/Rock', '01 Intro.mp3', 'Intro'), track('t2', 'Music/Rock', '02 Song.mp3', 'Song'), track('t3', '', 'Loose.mp3', 'Loose')]

const file = (name: string, text: string): File => new File([text], name, { type: 'audio/x-mpegurl' })

function target(playlists: Playlist[] = []) {
  const created: { name: string; ids: string[] }[] = []
  return {
    created,
    p: {
      tracks: library,
      playlists,
      createPlaylist: vi.fn((name?: string, ids: string[] = []) => {
        created.push({ name: name ?? '', ids })
        return `new${created.length}`
      }),
      setViewId: vi.fn(),
    },
  }
}

beforeEach(() => {
  overlays.cancelAll()
  for (const t of overlays.snapshot().toasts) overlays.dismissToast(t.id)
})

describe('importPlaylistFiles', () => {
  it('makes a playlist of the tracks the file names that the library has, and opens it', async () => {
    const { p, created } = target()
    await importPlaylistFiles(p, [file('Road Trip.m3u8', '#EXTM3U\nMusic/Rock/02 Song.mp3\nMusic/Rock/01 Intro.mp3\n')])
    expect(created).toEqual([{ name: 'Road Trip', ids: ['t2', 't1'] }])
    expect(p.setViewId).toHaveBeenCalledWith('new1')
    expect(overlays.snapshot().toasts.at(-1)?.text).toBe('Imported “Road Trip”: 2 tracks')
    expect(overlays.snapshot().dialog).toBeNull()
  })

  it('finds tracks written with Windows paths and another case', async () => {
    const { p, created } = target()
    await importPlaylistFiles(p, [file('Win.m3u', 'C:\\Backup\\MUSIC\\Rock\\01 INTRO.MP3\r\nLoose.mp3\r\n')])
    expect(created[0]?.ids).toEqual(['t1', 't3'])
  })

  it('tells what could not be found, and still imports what could', async () => {
    const { p, created } = target()
    const done = importPlaylistFiles(p, [file('Half.m3u8', ['#EXTM3U', '#EXTINF:100,Ghost - Gone', 'gone/ghost.mp3', 'Music/Rock/01 Intro.mp3', 'http://radio.example/stream'].join('\n'))])
    await vi.waitFor(() => expect(overlays.snapshot().dialog).not.toBeNull())
    const dialog = overlays.snapshot().dialog
    expect(dialog?.title).toBe('Imported “Half”')
    expect(dialog?.message).toContain('1 of 2 tracks')
    expect(dialog?.message).toContain('1 entry') // the radio stream
    expect(dialog?.details).toEqual(['Ghost - Gone'])
    overlays.answer(dialog?.id ?? -1, { ok: true })
    await done
    expect(created).toEqual([{ name: 'Half', ids: ['t1'] }])
  })

  it('does not make an empty playlist when nothing is in the library', async () => {
    const { p, created } = target()
    const done = importPlaylistFiles(p, [file('None.m3u8', 'gone/a.mp3\ngone/b.mp3')])
    await vi.waitFor(() => expect(overlays.snapshot().dialog).not.toBeNull())
    expect(overlays.snapshot().dialog?.title).toBe('Nothing to import from “None”')
    overlays.answer(overlays.snapshot().dialog?.id ?? -1, { ok: true })
    await done
    expect(created).toEqual([])
  })

  it('gives a playlist whose name is taken a number', async () => {
    const { p, created } = target([{ id: 'x', name: 'Road Trip', trackIds: [] }])
    await importPlaylistFiles(p, [file('Road Trip.m3u8', 'Music/Rock/01 Intro.mp3')])
    expect(created[0]?.name).toBe('Road Trip 2')
  })

  it('numbers two playlists of the same name from one import', async () => {
    const { p, created } = target()
    await importPlaylistFiles(p, [file('Mix.m3u8', 'Music/Rock/01 Intro.mp3'), file('Mix.pls', '[playlist]\nFile1=Music/Rock/02 Song.mp3')])
    expect(created.map((c) => c.name)).toEqual(['Mix', 'Mix 2'])
  })

  it('reads a PLS', async () => {
    const { p, created } = target()
    await importPlaylistFiles(p, [file('Faves.pls', '[playlist]\nFile1=Music/Rock/02 Song.mp3\nTitle1=Song\nNumberOfEntries=1')])
    expect(created).toEqual([{ name: 'Faves', ids: ['t2'] }])
  })

  it('says so for a file with nothing in it, and for one that is too big', async () => {
    const { p, created } = target()
    await importPlaylistFiles(p, [file('Empty.m3u8', '#EXTM3U\n'), new File([new Uint8Array(6 * 1024 * 1024)], 'Huge.m3u8')])
    expect(created).toEqual([])
    const texts = overlays.snapshot().toasts.map((t) => t.text)
    expect(texts).toContain('Empty.m3u8 has no tracks in it')
    expect(texts).toContain('Huge.m3u8 is too big to be a playlist')
  })
})

describe('exportPlaylist', () => {
  const playlist: Playlist = { id: 'p', name: 'Road/Trip', trackIds: ['t2', 'gone', 't3'] }

  it('downloads the playlist as an M3U8 with the tracks the library still has', async () => {
    const saved: { blob: Blob; name: string }[] = []
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      saved.push({ blob: new Blob(), name: this.download })
    })
    URL.createObjectURL = vi.fn(() => 'blob:x')
    URL.revokeObjectURL = vi.fn()
    exportPlaylist(playlist, library, 'm3u8')
    expect(click).toHaveBeenCalledTimes(1)
    expect(saved[0]?.name).toBe('Road_Trip.m3u8')
    expect(overlays.snapshot().toasts.at(-1)?.text).toBe('Exported 2 tracks as Road_Trip.m3u8')
  })

  it('does not download an empty playlist, and says why', () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    exportPlaylist({ id: 'e', name: 'Empty', trackIds: [] }, library, 'pls')
    expect(click).not.toHaveBeenCalled()
    expect(overlays.snapshot().toasts.at(-1)?.text).toBe('“Empty” is empty: there is nothing to export')
  })
})
