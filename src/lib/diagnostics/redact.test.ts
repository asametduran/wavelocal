// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { MAX_FRAME, MAX_FRAMES, MAX_MESSAGE, cleanFrames, cleanName, clip, describeError, redact } from './redact'

describe('redact: messages the browser writes stay readable', () => {
  it.each([
    'The quota has been exceeded.',
    'Unable to decode audio data',
    'The transaction has finished.',
    "Can't read the user's file",
    'The play() request was interrupted by a call to pause().',
    'Cannot read properties of undefined',
    '',
  ])('keeps %j as it is', (text) => {
    expect(redact(text)).toBe(text)
  })

  it('takes what an API said it failed on out of the sentence and keeps the rest', () => {
    expect(redact("Failed to execute 'put' on 'IDBObjectStore': The transaction has finished.")).toBe('Failed to execute <text> on <text>: The transaction has finished.')
  })

  it('does not mistake an apostrophe inside a word, or after a plural, for a quote', () => {
    expect(redact("It's the users' library and doesn't open")).toBe("It's the users' library and doesn't open")
  })
})

describe('redact: quoted text', () => {
  it.each([
    ['double quotes', 'Could not read "Yesterday (Remastered)" at all'],
    ['single quotes', "Could not read 'Yesterday' at all"],
    ['back ticks', 'Could not read `Yesterday` at all'],
    ['curly double quotes', 'Could not read \u201cYesterday\u201d at all'],
    ['low curly quotes', 'Could not read \u201eYesterday\u201d at all'],
    ['curly single quotes', 'Could not read \u2018Yesterday\u2019 at all'],
    ['guillemets', 'Could not read \u00abYesterday\u00bb at all'],
    ['single guillemets', 'Could not read \u2039Yesterday\u203a at all'],
  ])('takes out text in %s', (_name, text) => {
    expect(redact(text)).toBe('Could not read <text> at all')
  })

  it('takes out a quote that never closes together with everything after it', () => {
    expect(redact('Could not read "Yesterday and then some')).toBe('Could not read <text>')
    expect(redact("Could not read 'Yesterday and then some")).toBe('Could not read <text>')
  })

  it('takes out a title with apostrophes in it whole', () => {
    expect(redact("Failed to read 'Don't Stop Me Now'")).toBe('Failed to read <text>')
  })

  it('takes out several quoted pieces one by one', () => {
    expect(redact('"a" and "b" and \'c\'')).toBe('<text> and <text> and <text>')
  })

  it('takes out quoted text that holds a link, a path or another kind of quote', () => {
    expect(redact('Bad "https://example.com/a b" and "C:\\Music\\x.mp3" and "it\'s"')).toBe('Bad <text> and <text> and <text>')
  })
})

describe('redact: links, paths and files', () => {
  it.each([
    ['a web address', 'Failed to fetch https://example.com/music/a.mp3?x=1 now', 'Failed to fetch <url> now'],
    ['a blob address', 'Failed to load blob:https://example.com/3f2c1c3e-aaaa-bbbb-cccc-0123456789ab', 'Failed to load <url>'],
    ['a file address', 'Failed to open file:///C:/Users/me/Music/a.mp3', 'Failed to open <url>'],
    ['a data address', 'Bad source data:audio/mpeg;base64,AAAAAAAAAAAAAAAAAAAA', 'Bad source <url>'],
    ['a custom scheme', 'Cannot load capacitor://localhost/assets/a.js', 'Cannot load <url>'],
  ])('takes out %s', (_name, text, expected) => {
    expect(redact(text)).toBe(expected)
  })

  it.each([
    ['a Windows path', 'Cannot read C:\\Users\\Jane Doe\\Music\\My Song.mp3', 'Cannot read <path>'],
    ['a Windows path with slashes, and what follows it', 'Cannot read C:/Users/Jane Doe/Music/My Song.mp3 (code 4)', 'Cannot read <path>'],
    ['a POSIX path', 'Cannot read /storage/emulated/0/Music/My Song.mp3', 'Cannot read <path>'],
    ['a relative path', 'Cannot read Music/Album/01 Song.mp3', 'Cannot read <path>'],
    ['a path, up to the next colon', 'Cannot read Music/Album/01 Song: not found', 'Cannot read <path>: not found'],
  ])('takes out %s', (_name, text, expected) => {
    expect(redact(text)).toBe(expected)
  })

  it.each(['mp3', 'm4a', 'flac', 'ogg', 'opus', 'wav', 'aiff', 'wma', 'lrc', 'm3u8', 'pls', 'jpg', 'png', 'json'])('takes out a file name that ends in .%s', (extension) => {
    expect(redact(`Decoding 01 - Song (Live) & Friends, Part 1.${extension} failed`)).toBe('<file> failed')
  })

  it('takes out the phrase that leads up to a file name, but not what a colon or semicolon ends', () => {
    expect(redact('Error: Artist, Title (Live).mp3')).toBe('Error: <file>')
    expect(redact("Error; Don't Stop.flac")).toBe('Error; <file>')
  })

  it('leaves files of the app itself alone', () => {
    expect(redact('The build has no index.html, so no page could be opened offline')).toBe('The build has no index.html, so no page could be opened offline')
    expect(redact('Cannot load chunk.js')).toBe('Cannot load chunk.js')
  })
})

describe('redact: addresses, numbers and codes', () => {
  it('takes out an e-mail address', () => {
    expect(redact('Sent to jane.doe+music@example.co.uk twice')).toBe('Sent to <email> twice')
  })

  it('takes out identifiers and long numbers', () => {
    expect(redact('Record 3f2c1c3e-1111-2222-3333-0123456789ab missing')).toBe('Record <id> missing')
    expect(redact('Phone 5551234567 failed')).toBe('Phone <n> failed')
    expect(redact('Key AbCdEfGhIjKlMnOpQrStUvWxYz0123 unknown')).toBe('Key <id> unknown')
  })

  it('leaves short numbers alone', () => {
    expect(redact('Failed at line 120, column 45 with code 22')).toBe('Failed at line 120, column 45 with code 22')
  })
})

describe('redact: the result is plain and bounded', () => {
  it('turns control characters and line breaks into single spaces', () => {
    expect(redact('a\n\n  b\t\tc\u0000d\u2028e')).toBe('a b c d e')
  })

  it('cuts a long message short with an ellipsis, by whole characters', () => {
    const cut = redact('word '.repeat(200))
    expect(Array.from(cut)).toHaveLength(MAX_MESSAGE)
    expect(cut.endsWith('\u2026')).toBe(true)
    const emoji = redact('\u{1F3B5}'.repeat(400), 10)
    expect(Array.from(emoji)).toHaveLength(10)
    expect(emoji).toBe(`${'\u{1F3B5}'.repeat(9)}\u2026`)
  })

  it('looks at a bounded amount of text, however much it is given and however hostile', () => {
    for (const huge of ['"'.repeat(200_000) + 'x'.repeat(200_000), 'a.'.repeat(100_000), '/'.repeat(100_000), '("'.repeat(50_000), `${"'".repeat(50_000)}a`, '0'.repeat(300_000)]) {
      expect(Array.from(redact(huge)).length).toBeLessThanOrEqual(MAX_MESSAGE)
    }
  })

  it('gives the same answer when it is applied again', () => {
    for (const text of ['Could not read "Yesterday" at C:\\Music\\a b.mp3', 'x https://e.com/a y jane@example.com 123456789', "Failed to execute 'put' on 'IDBObjectStore'", 'plain text']) {
      expect(redact(redact(text))).toBe(redact(text))
    }
  })
})

describe('clip', () => {
  it('leaves short text alone and cuts the rest', () => {
    expect(clip('abc', 3)).toBe('abc')
    expect(clip('abcd', 3)).toBe('ab\u2026')
    expect(clip('abcd', 1)).toBe('\u2026')
    expect(clip('abcd', 0)).toBe('\u2026')
  })
})

describe('cleanName', () => {
  it.each(['QuotaExceededError', 'TypeError', 'AudioDecodeError', 'DOMException', 'My.Error-2'])('keeps %s', (name) => {
    expect(cleanName(name)).toBe(name)
  })

  it.each([undefined, null, 5, {}, '', ' Error', 'Error: x', 'Song Title', '1Error', 'a'.repeat(61), 'x\ny'])('replaces %j with Error', (name) => {
    expect(cleanName(name)).toBe('Error')
  })
})

describe('cleanFrames', () => {
  it('reads Chrome and Edge frames: the function and the built file, never the link', () => {
    const stack = [
      'Error: boom "secret title"',
      '    at putTracks (https://example.com/assets/index-BjU59TV4.js:1:23456)',
      '    at async Promise.all (index 0)',
      '    at https://example.com/assets/log-abc123.js:7:8',
      '    at new Foo (https://example.com/assets/index-BjU59TV4.js?v=2:3:4)',
      '    at Object.method [as alias] (http://127.0.0.1:4173/assets/Tools-xyz.js:10:20)',
    ].join('\n')
    expect(cleanFrames(stack)).toEqual([
      'putTracks (index-BjU59TV4.js:1:23456)',
      'log-abc123.js:7:8',
      'new Foo (index-BjU59TV4.js:3:4)',
      'Object.method [as alias] (Tools-xyz.js:10:20)',
    ])
  })

  it('reads Firefox and Safari frames', () => {
    const stack = ['putTracks@https://example.com/assets/index-BjU59TV4.js:1:23456', '@https://example.com/assets/log-abc123.js:7:8', 'global code@https://e.com/a.js:1:2'].join('\n')
    expect(cleanFrames(stack)).toEqual(['putTracks (index-BjU59TV4.js:1:23456)', 'log-abc123.js:7:8', 'global code (a.js:1:2)'])
  })

  it('reads the source files of a development build', () => {
    expect(cleanFrames('    at record (http://localhost:5173/src/lib/diagnostics/log.ts?t=123:45:6)')).toEqual(['record (log.ts:45:6)'])
  })

  it('leaves out lines that are not places in the app: an extension, a worker, a line of the message', () => {
    const stack = [
      'Error: a message with a link https://example.com/x',
      '    at hook (chrome-extension://abcdef/content.js:1:2)',
      '    at onmessage (blob:https://example.com/3f2c1c3e-aaaa:1:2)',
      '    at <anonymous>',
    ].join('\n')
    expect(cleanFrames(stack)).toEqual([])
  })

  it('leaves out a function name that is not a name', () => {
    expect(cleanFrames('    at "Song Title" ; rm -rf (https://e.com/assets/a.js:1:2)')).toEqual(['a.js:1:2'])
  })

  it('keeps a bounded number of frames of a bounded length', () => {
    const stack = Array.from({ length: 40 }, (_, i) => `    at f${i} (https://e.com/assets/${'x'.repeat(300)}.js:${i}:1)`).join('\n')
    const frames = cleanFrames(stack)
    expect(frames).toHaveLength(MAX_FRAMES)
    for (const frame of frames) expect(Array.from(frame).length).toBeLessThanOrEqual(MAX_FRAME)
  })

  it.each([undefined, null, 5, {}, ''])('reads %j as no frames', (stack) => {
    expect(cleanFrames(stack)).toEqual([])
  })
})

describe('describeError', () => {
  it('describes an error by its name, its cleaned message and its places', () => {
    const error = new TypeError("Cannot read 'title' of C:\\Music\\a b.mp3")
    error.stack = 'TypeError: x\n    at render (https://e.com/assets/index-abc.js:5:6)'
    expect(describeError(error)).toEqual({ name: 'TypeError', message: 'Cannot read <text> of <path>', frames: ['render (index-abc.js:5:6)'] })
  })

  it('describes a DOMException by its own name', () => {
    expect(describeError(new DOMException('The quota has been exceeded.', 'QuotaExceededError')).name).toBe('QuotaExceededError')
  })

  it('describes things that are not errors', () => {
    expect(describeError('plain "Song" words')).toEqual({ name: 'Error', message: 'plain <text> words', frames: [] })
    expect(describeError(42)).toEqual({ name: 'Error', message: '42', frames: [] })
    expect(describeError(undefined)).toEqual({ name: 'Error', message: 'undefined', frames: [] })
    expect(describeError(null)).toEqual({ name: 'Error', message: 'null', frames: [] })
    expect(describeError({ title: 'Song Title' })).toEqual({ name: 'Error', message: '{<text>:<text>}', frames: [] })
  })

  it('describes an object that has a message like an error', () => {
    expect(describeError({ name: 'Custom', message: 'went wrong' })).toEqual({ name: 'Custom', message: 'went wrong', frames: [] })
  })

  it('never throws, whatever it is given', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const hostile = {
      get message(): string {
        throw new Error('no')
      },
    }
    const refuses = (): never => {
      throw new Error('no')
    }
    const proxy = new Proxy({}, { get: refuses, has: refuses, ownKeys: refuses })
    for (const value of [circular, hostile, proxy, Symbol('x'), () => 1, 10n, Object.create(null)]) {
      expect(() => describeError(value)).not.toThrow()
    }
    expect(describeError(circular).message).toBe('[object Object]')
  })
})
