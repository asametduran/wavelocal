import { beforeEach, describe, expect, it, vi } from 'vitest'
import { saveFile, saveWords } from './index'
import type { SaveFailure, SaveOutcome } from './index'

// Which way a file goes (a download, or the Android saver in a chunk of its own), what is told to the error log, and the words.

const mocks = vi.hoisted(() => ({
  isNative: vi.fn(),
  download: vi.fn(),
  note: vi.fn(),
  /** What `import('./plugins')` reads: the saver, or a failure to load the chunk. */
  plugins: vi.fn(),
}))
vi.mock('../platform', () => ({ isNativeApp: mocks.isNative }))
vi.mock('../download', () => ({ downloadBlob: mocks.download }))
vi.mock('../diagnostics/capture', () => ({ note: (kind: string) => (error: unknown) => mocks.note(kind, error) }))
vi.mock('./plugins', () => ({
  get saveNative() {
    return mocks.plugins()
  },
}))

const blob = new Blob(['x'])

beforeEach(() => {
  mocks.isNative.mockReset().mockReturnValue(false)
  mocks.download.mockReset()
  mocks.note.mockReset()
  mocks.plugins.mockReset()
})

describe('saveFile on the web and in the desktop shell', () => {
  it('starts a download, says so, and never loads the Android saver', async () => {
    expect(await saveFile(blob, 'a.m3u8')).toEqual({ kind: 'downloaded' })
    expect(mocks.download).toHaveBeenCalledWith(blob, 'a.m3u8')
    expect(mocks.plugins).not.toHaveBeenCalled()
    expect(mocks.note).not.toHaveBeenCalled()
  })

  it('answers with a failure, and tells the error log, when the download cannot be started', async () => {
    const failure = new Error('blocked')
    mocks.download.mockImplementation(() => {
      throw failure
    })
    expect(await saveFile(blob, 'a.m3u8')).toEqual({ kind: 'failed', why: 'other', error: failure })
    expect(mocks.note).toHaveBeenCalledWith('save', failure)
  })
})

describe('saveFile in the Android app', () => {
  beforeEach(() => mocks.isNative.mockReturnValue(true))

  it('hands the file to the Android saver and answers what it answers, with no download', async () => {
    const saver = vi.fn(async () => ({ kind: 'shared' }) as SaveOutcome)
    mocks.plugins.mockReturnValue(saver)
    expect(await saveFile(blob, 'a.m3u8')).toEqual({ kind: 'shared' })
    expect(saver).toHaveBeenCalledWith(blob, 'a.m3u8')
    expect(mocks.download).not.toHaveBeenCalled()
    expect(mocks.note).not.toHaveBeenCalled()
  })

  it.each<[string, SaveOutcome]>([
    ['a share sheet that was closed', { kind: 'cancelled' }],
    ['a save that is already open', { kind: 'failed', why: 'busy', error: new Error('open') }],
  ])('does not bother the error log with %s', async (_name, outcome) => {
    mocks.plugins.mockReturnValue(async () => outcome)
    expect(await saveFile(blob, 'a.m3u8')).toEqual(outcome)
    expect(mocks.note).not.toHaveBeenCalled()
  })

  it.each<SaveFailure>(['full', 'other'])('tells the error log about a failure that is a reason of the device: %s', async (why) => {
    const error = new Error('No space left on device')
    mocks.plugins.mockReturnValue(async () => ({ kind: 'failed', why, error }))
    expect(await saveFile(blob, 'a.m3u8')).toEqual({ kind: 'failed', why, error })
    expect(mocks.note).toHaveBeenCalledWith('save', error)
  })

  it('is "unavailable", and in the error log, when the chunk with the plugins cannot be loaded', async () => {
    const failure = new TypeError('Failed to fetch dynamically imported module')
    mocks.plugins.mockImplementation(() => {
      throw failure
    })
    expect(await saveFile(blob, 'a.m3u8')).toEqual({ kind: 'failed', why: 'unavailable', error: failure })
    expect(mocks.note).toHaveBeenCalledWith('save', failure)
    expect(mocks.download).not.toHaveBeenCalled()
  })

  it('never throws, even when the saver does', async () => {
    const failure = new Error('bridge gone')
    mocks.plugins.mockReturnValue(async () => {
      throw failure
    })
    expect(await saveFile(blob, 'a.m3u8')).toEqual({ kind: 'failed', why: 'unavailable', error: failure })
  })
})

describe('saveWords', () => {
  it('has nothing to say about a download: each caller has its own words for it', () => {
    expect(saveWords({ kind: 'downloaded' }, 'a.m3u8')).toBeNull()
  })

  it('says what a person did with the share sheet', () => {
    expect(saveWords({ kind: 'shared' }, 'a.m3u8')).toBe('Shared a.m3u8.')
    expect(saveWords({ kind: 'cancelled' }, 'a.m3u8')).toBe('Not saved: the share sheet was closed.')
  })

  it.each<[SaveFailure, string]>([
    ['full', 'Could not save a.m3u8: this device has no room left.'],
    ['busy', 'Could not save a.m3u8: another save is still open.'],
    ['unavailable', 'Could not save a.m3u8: this app cannot save files here.'],
    ['other', 'Could not save a.m3u8: something went wrong, and the details are in Sound & tools → Diagnostics.'],
  ])('says why it failed: %s', (why, words) => {
    expect(saveWords({ kind: 'failed', why, error: new Error('x') }, 'a.m3u8')).toBe(words)
  })

  it('never says "Exported", which claims more than a share sheet can tell', () => {
    const outcomes: SaveOutcome[] = [{ kind: 'shared' }, { kind: 'cancelled' }, { kind: 'failed', why: 'other', error: null }]
    for (const outcome of outcomes) expect(saveWords(outcome, 'a.m3u8')).not.toMatch(/exported/i)
  })
})
