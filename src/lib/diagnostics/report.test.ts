// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { appBuild, buildReport, describeBrowser } from './report'
import type { LogEntry } from './types'

const context = { build: 'BjU59TV4', browser: 'Chrome 141 on Windows', now: Date.UTC(2026, 9, 18, 12, 3, 5) }
const entry = (over: Partial<LogEntry> = {}): LogEntry => ({ at: Date.UTC(2026, 9, 18, 12, 2, 11), kind: 'save', name: 'QuotaExceededError', message: 'The quota has been exceeded.', frames: [], count: 1, ...over })
const FOOTER = 'File names, tags and settings are left out. This text was made on this device when you asked for it; nothing was sent anywhere.'

describe('buildReport', () => {
  it('says so when nothing has been recorded', () => {
    expect(buildReport([], context)).toBe(['Wavelocal error report', 'Build BjU59TV4 · Chrome 141 on Windows', 'Made 2026-10-18T12:03:05Z', '', 'No errors have been recorded.', '', FOOTER].join('\n'))
  })

  it('lists the newest entry first, with its kind, name, count, message and places', () => {
    const entries = [
      entry({ at: Date.UTC(2026, 9, 18, 12, 0, 0), kind: 'decode', name: 'EncodingError', message: 'Unable to decode audio data', count: 1 }),
      entry({ frames: ['putTracks (index-BjU59TV4.js:1:23456)', 'run (index-BjU59TV4.js:7:8)'], count: 3 }),
    ]
    expect(buildReport(entries, context)).toBe(
      [
        'Wavelocal error report',
        'Build BjU59TV4 · Chrome 141 on Windows',
        'Made 2026-10-18T12:03:05Z',
        '',
        '2 entries, newest first:',
        '',
        '2026-10-18T12:02:11Z · save · QuotaExceededError (×3)',
        '  The quota has been exceeded.',
        '  at putTracks (index-BjU59TV4.js:1:23456)',
        '  at run (index-BjU59TV4.js:7:8)',
        '',
        '2026-10-18T12:00:00Z · decode · EncodingError',
        '  Unable to decode audio data',
        '',
        FOOTER,
      ].join('\n'),
    )
  })

  it('says "entry" for one', () => {
    expect(buildReport([entry()], context)).toContain('1 entry, newest first:')
  })

  it('leaves out a message that is empty, and shows no count for a failure that happened once', () => {
    const text = buildReport([entry({ message: '' })], context)
    expect(text).toContain('2026-10-18T12:02:11Z · save · QuotaExceededError\n\n')
    expect(text).not.toContain('×')
  })

  it('does not change the list it is given', () => {
    const entries = Object.freeze([entry({ message: 'a' }), entry({ message: 'b', kind: 'error' })])
    buildReport(entries, context)
    expect(entries.map((e) => e.message)).toEqual(['a', 'b'])
  })

  it('makes a time of what is not one', () => {
    expect(buildReport([entry({ at: Number.NaN })], { ...context, now: Number.POSITIVE_INFINITY })).toContain('Made unknown time')
    expect(buildReport([entry({ at: Number.NaN })], context)).toContain('unknown time · save')
  })

  it('holds nothing beyond the build, the browser, the time and the entries', () => {
    const lines = buildReport([entry()], context).split('\n')
    expect(lines.filter((line) => line !== '' && !line.startsWith(' ')).map((line) => line.split(' ')[0])).toEqual(['Wavelocal', 'Build', 'Made', '1', '2026-10-18T12:02:11Z', 'File'])
  })
})

describe('describeBrowser', () => {
  it.each([
    ['Chrome on Windows', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36', 'Chrome 141 on Windows'],
    ['Edge', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.2200.5', 'Edge 141 on Windows'],
    ['Opera', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 OPR/120.0.0.0', 'Opera 120 on Windows'],
    ['Firefox on Linux', 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0', 'Firefox 131 on Linux'],
    ['Safari on a Mac', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15', 'Safari 17 on macOS'],
    ['Safari on an iPhone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1', 'Safari 17 on iOS'],
    ['Chrome on Android', 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36', 'Chrome 141 on Android'],
    ['the Android app (a WebView)', 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240805.005; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.0.0 Mobile Safari/537.36', 'Android WebView 141 on Android'],
    ['the desktop app', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) wavelocal/1.0.0 Chrome/140.0.7339.0 Electron/38.0.0 Safari/537.36', 'Electron 38 on Windows'],
    ['Chrome on a Chromebook', 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36', 'Chrome 141 on ChromeOS'],
  ])('says %s in a few words', (_name, userAgent, expected) => {
    expect(describeBrowser(userAgent)).toBe(expected)
  })

  it('says nothing that tells one device from another', () => {
    const said = describeBrowser('Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240805.005; wv) AppleWebKit/537.36 Chrome/141.0.6723.58 Mobile Safari/537.36')
    expect(said).not.toMatch(/Pixel|AP2A|6723|14;/)
  })

  it('gives up gracefully on what it does not know', () => {
    expect(describeBrowser('curl/8.0')).toBe('an unknown browser')
    expect(describeBrowser('')).toBe('an unknown browser')
  })
})

describe('appBuild', () => {
  it('reads the build from the name of the entry script', () => {
    expect(appBuild([{ src: 'https://example.com/assets/log-abc123.js' }, { src: 'https://example.com/assets/index-BjU59TV4.js' }])).toBe('BjU59TV4')
    expect(appBuild([{ src: 'http://127.0.0.1:4173/assets/index-Ab_c-D12.js?x=1' }])).toBe('Ab_c-D12')
  })

  it('is "development" when there is no such script', () => {
    expect(appBuild([])).toBe('development')
    expect(appBuild([{ src: 'http://localhost:5173/src/main.tsx' }, { src: '' }, { src: 'https://example.com/assets/react-xyz12345.js' }])).toBe('development')
  })
})
