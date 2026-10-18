// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { FUZZ_TIMEOUT, eachSeed, int, mutateText, pick } from '../../test-utils/fuzz'
import type { Random } from '../../test-utils/fuzz'
import { DiagnosticsLog, MAX_COUNT, MAX_ENTRIES, MAX_STORED, STORAGE_KEY, readEntries } from './log'
import type { LogStorage } from './log'
import { MAX_FRAME, MAX_FRAMES, MAX_MESSAGE, cleanFrames, cleanName, describeError, redact } from './redact'
import { buildReport } from './report'
import { LOG_KINDS } from './types'
import type { LogEntry } from './types'

/**
 * The log is read by a person, copied, and sent to someone: what it holds must be bounded whatever it is given, and a name the person
 * owns (a file, a title, a folder) must never be in it. These tests throw hostile names and damaged stores at it with fixed seeds.
 */

const LETTERS = Array.from('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ\u00e9\u00fc\u00e7\u00df\u0130\u0131\u00f1\u00f8\u00e5\u0414\u0436\u042f\u3042\u5b57')
const MARKS = Array.from('-_.,!&#()[]{}0123456789')
const EXTENSIONS = ['mp3', 'm4a', 'flac', 'ogg', 'wav', 'opus', 'lrc', 'm3u8', 'jpg', 'png']

/** A secret that no message of the app contains, so that finding it in a report means a name got through. */
const secretFor = (seed: number): string => `Zq${seed}Xv`

/**
 * A hostile name: words and marks in any order, with spaces, apostrophes inside words, odd letters, and the seed's secret as one of the
 * words. It holds no quotes, colons or separators: those end or split a name in every message that can carry one.
 */
function hostileName(random: Random, secret: string): string {
  const words: string[] = []
  const count = 1 + int(random, 5)
  const secretAt = int(random, count)
  for (let i = 0; i < count; i++) {
    if (i === secretAt) {
      words.push(secret)
      continue
    }
    let word = ''
    for (let j = 0, n = 1 + int(random, 8); j < n; j++) word += random() < 0.8 ? pick(random, LETTERS) : pick(random, MARKS)
    if (random() < 0.2) word = word.replace(/(\p{L})(\p{L})/u, "$1'$2") // an apostrophe inside a word
    words.push(word)
  }
  return words.join(random() < 0.5 ? ' ' : ' - ')
}

/** The ways a message can carry a name that the app's own code never would, but the browser and its parts might. */
const FORMS: readonly (readonly [string, (name: string, ext: string) => string])[] = [
  ['double quotes', (n) => `Could not read "${n}" at all`],
  ['single quotes', (n) => `Could not read '${n}' at all`],
  ['back ticks', (n) => `Could not read \`${n}\` at all`],
  ['curly quotes', (n) => `Could not read \u201c${n}\u201d at all`],
  ['guillemets', (n) => `Could not read \u00ab${n}\u00bb at all`],
  ['a Windows path', (n, e) => `Cannot read C:\\Users\\someone\\Music\\${n}.${e}`],
  ['a Windows path with slashes', (n, e) => `Cannot read C:/Users/someone/Music/${n}.${e} (code 4)`],
  ['a POSIX path', (n, e) => `Cannot read /storage/emulated/0/Music/${n}.${e}`],
  ['a relative path', (n, e) => `Cannot read Music/${n}.${e}`],
  ['a web address', (n, e) => `Failed to fetch https://example.com/music/${encodeURIComponent(n)}.${e}?x=1 now`],
  ['a blob address', (n) => `Failed to load blob:https://example.com/${encodeURIComponent(n)}`],
  ['a file address', (n, e) => `Failed to open file:///C:/Users/me/${encodeURIComponent(n)}.${e}`],
  ['a bare file name', (n, e) => `Failed to decode ${n}.${e} after a while`],
  ['a bare file name after a colon', (n, e) => `Error: ${n}.${e}`],
  ['JSON', (n) => JSON.stringify({ title: n, artist: n })],
  ['an e-mail address', (n) => `Sent to ${n.replace(/[^A-Za-z0-9]/g, '')}@example.com twice`],
]

describe('the log never holds a name the person owns', { timeout: FUZZ_TIMEOUT }, () => {
  it.each(FORMS)('in a message that carries it in %s', async (_form, make) => {
    await eachSeed(150, (random, seed) => {
      const secret = secretFor(seed)
      const message = make(hostileName(random, secret), pick(random, EXTENSIONS))
      const said = redact(message)
      expect(said).not.toContain(secret)
      expect(Array.from(said).length).toBeLessThanOrEqual(MAX_MESSAGE)

      // and the whole way: through the log, its store and the report that is copied
      const storage = new MemoryStorage()
      const log = new DiagnosticsLog(storage, () => 1_700_000_000_000)
      log.record('error', new Error(message))
      log.record('rejection', message)
      log.record('save', { message, stack: `Error: ${message}\n    at run (https://e.com/assets/a.js:1:2)` })
      const report = buildReport(log.snapshot(), { build: 'abc', browser: 'Chrome 141', now: 1_700_000_001_000 })
      expect(report).not.toContain(secret)
      expect(storage.items.get(STORAGE_KEY) ?? '').not.toContain(secret)
    })
  })

  it('nor in an error name that is a phrase and not a name, nor in the lines of a stack that are not places in the code', async () => {
    await eachSeed(150, (random, seed) => {
      const secret = secretFor(seed)
      const phrase = `${hostileName(random, secret)} extra` // a name of an error is one word of code; this has a space
      const error = Object.assign(new Error('x'), { name: phrase, stack: `${hostileName(random, secret)}\n${phrase}: ${hostileName(random, secret)}\n    at <anonymous>` })
      expect(JSON.stringify(describeError(error))).not.toContain(secret)
    })
  })
})

describe('anything can be recorded, and what is kept is bounded', { timeout: FUZZ_TIMEOUT }, () => {
  const damaged = (random: Random, seed: number): unknown => {
    switch (seed % 8) {
      case 0:
        return mutateText(random, 'Error: something "quoted" at C:\\Music\\a.mp3 https://e.com/x 123456789')
      case 1:
        return { message: mutateText(random, 'x'.repeat(int(random, 3000))), stack: mutateText(random, '    at f (https://e.com/assets/a.js:1:2)\n'.repeat(1 + int(random, 60))) }
      case 2:
        return Object.assign(new Error(mutateText(random, 'boom')), { name: mutateText(random, 'TypeError') })
      case 3:
        return [random(), mutateText(random, 'list'), null]
      case 4:
        return random() < 0.5 ? undefined : null
      case 5:
        return Math.floor(random() * 1e9) - 5e8
      case 6:
        return mutateText(random, JSON.stringify({ title: 'Song', nested: { a: [1, 2, 3] } }))
      default:
        return Symbol(mutateText(random, 'sym'))
    }
  }

  it('describes any value as a clean name, a bounded message and bounded frames', async () => {
    await eachSeed(400, (random, seed) => {
      const described = describeError(damaged(random, seed))
      expect(described.name).toMatch(/^[A-Za-z][\w.$-]{0,59}$/)
      expect(Array.from(described.message).length).toBeLessThanOrEqual(MAX_MESSAGE)
      expect(described.frames.length).toBeLessThanOrEqual(MAX_FRAMES)
      for (const frame of described.frames) expect(Array.from(frame).length).toBeLessThanOrEqual(MAX_FRAME)
    })
  })

  it('redacts any text without throwing, to the same text when applied again', async () => {
    await eachSeed(400, (random, seed) => {
      const text = mutateText(random, pick(random, ['Could not read "a b" at C:\\Music\\x.mp3', "Failed to execute 'put' on 'IDB'", 'blob:https://e.com/x', 'a@b.co 123456789', 'plain']) + (seed % 3 === 0 ? '"'.repeat(int(random, 30)) : ''))
      const once = redact(text)
      expect(Array.from(once).length).toBeLessThanOrEqual(MAX_MESSAGE)
      expect(redact(once)).toBe(once)
      expect(() => cleanFrames(text)).not.toThrow()
      expect(cleanName(text)).toMatch(/^[A-Za-z][\w.$-]{0,59}$/)
    })
  })

  it('keeps a list that never breaks its bounds, through random records, clears, restores and refreshes in two windows', async () => {
    await eachSeed(150, (random, seed) => {
      const storage = new MemoryStorage()
      let now = 1000
      const windows = [new DiagnosticsLog(storage, () => (now += 1000)), new DiagnosticsLog(storage, () => (now += 1000))]
      let removed: readonly LogEntry[] = []
      for (let step = 0; step < 80; step++) {
        const log = pick(random, windows)
        storage.failWrites = random() < 0.05
        storage.failReads = random() < 0.05
        switch (int(random, 6)) {
          case 0:
          case 1:
          case 2:
            log.record(pick(random, LOG_KINDS), random() < 0.3 ? new Error(`same ${int(random, 3)}`) : damaged(random, int(random, 100_000)))
            break
          case 3:
            removed = log.clear()
            break
          case 4:
            log.restore(removed)
            break
          default:
            log.refresh()
        }
        for (const each of windows) validate(each.snapshot(), `seed ${seed}, step ${step}`)
        expect((storage.items.get(STORAGE_KEY) ?? '').length).toBeLessThanOrEqual(MAX_STORED)
      }
    })
  })
})

describe('a damaged store reads as a log that can be used', { timeout: FUZZ_TIMEOUT }, () => {
  const good = JSON.stringify({
    v: 1,
    entries: [
      { at: 1000, kind: 'save', name: 'QuotaExceededError', message: 'The quota has been exceeded.', frames: ['f (a.js:1:2)'], count: 3 },
      { at: 2000, kind: 'decode', name: 'EncodingError', message: 'Unable to decode audio data', frames: [], count: 1 },
    ],
  })

  it('reads any mutation of a stored log as entries that are all valid, and goes on recording', async () => {
    await eachSeed(500, (random) => {
      const storage = new MemoryStorage()
      storage.items.set(STORAGE_KEY, mutateText(random, good))
      const log = new DiagnosticsLog(storage)
      validate(log.snapshot(), 'after reading')
      log.record('error', new Error('after'))
      validate(log.snapshot(), 'after recording')
      expect(log.snapshot()[log.snapshot().length - 1]?.message).toBe('after')
    })
  })

  it('reads any list of anything as valid entries', async () => {
    await eachSeed(400, (random) => {
      const raw = Array.from({ length: int(random, 80) }, () =>
        random() < 0.5
          ? { at: pick(random, [0, 1000, -1, Number.NaN, 9e15, '5', null]), kind: pick(random, [...LOG_KINDS, 'nope', 5, null]), name: pick(random, ['TypeError', 'x y', 5, '']), message: pick(random, ['ok', 'C:\\Music\\a.mp3', 5, 'x'.repeat(2000)]), frames: pick(random, [[], ['a (b.js:1:1)'], 'no', [5, 'z'.repeat(999)], Array.from({ length: 40 }, () => 'q')]), count: pick(random, [1, 0, -2, 1.5, 1e9, '3']) }
          : pick(random, [null, 5, 'text', [], {}]),
      )
      validate(readEntries(raw), 'readEntries')
    })
  })
})

class MemoryStorage implements LogStorage {
  readonly items = new Map<string, string>()
  failReads = false
  failWrites = false

  getItem(key: string): string | null {
    if (this.failReads) throw new Error('unreadable')
    return this.items.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    if (this.failWrites) throw new Error('full')
    this.items.set(key, value)
  }

  removeItem(key: string): void {
    this.items.delete(key)
  }
}

/** Every entry is one the log could have written: its kind, name, text, frames and count are within the bounds. */
function validate(entries: readonly LogEntry[], where: string): void {
  expect(entries.length, where).toBeLessThanOrEqual(MAX_ENTRIES)
  for (const entry of entries) {
    expect(Number.isFinite(entry.at) && entry.at >= 0, where).toBe(true)
    expect(LOG_KINDS, where).toContain(entry.kind)
    expect(entry.name, where).toMatch(/^[A-Za-z][\w.$-]{0,59}$/)
    expect(Array.from(entry.message).length, where).toBeLessThanOrEqual(MAX_MESSAGE)
    expect(entry.frames.length, where).toBeLessThanOrEqual(MAX_FRAMES)
    for (const frame of entry.frames) expect(Array.from(frame).length, where).toBeLessThanOrEqual(MAX_FRAME)
    expect(Number.isInteger(entry.count) && entry.count >= 1 && entry.count <= MAX_COUNT, where).toBe(true)
  }
}
