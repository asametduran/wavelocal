import { describe, expect, it } from 'vitest'
import { MAX_ENTRIES, decodePlaylist, matchEntries, parsePlaylist, pathSegments } from './playlistfiles'
import type { MatchResult, MatchTrack, ParsedPlaylist, PlaylistEntry } from './playlistfiles'
import { fold } from './search'
import { FUZZ_TIMEOUT, eachSeed, int, mutateBytes, mutateText, pick, randomBytes, randomText, timed } from '../test-utils/fuzz'
import type { Random } from '../test-utils/fuzz'

const M3U = [
  '#EXTM3U',
  '#PLAYLIST:Road trip',
  '#EXTINF:215,An Artist - A Song',
  'Music/Rock/01 A Song.mp3',
  '#EXTINF:-1 tvg-id="x",A Stream',
  'http://stream.example/live',
  '"C:\\Users\\me\\Music\\02 Other.flac"',
  '#EXTINF:60.5,Third',
  'file:///home/me/Music/03%20Third.ogg',
].join('\r\n')
const PLS = ['[playlist]', 'File1=Music/a.mp3', 'Title1=Artist - Song', 'Length1=215', 'File2=http://radio.example/stream', 'File3="Music/c.mp3"', 'NumberOfEntries=3', 'Version=2'].join('\n')

const CONTROL = /[\u0000-\u001f\u007f]/
const STREAM = /^(?:https?|rtsp|rtmp|mmsh?|ftp|icy):\/\//i

/** What a parsed playlist has to be, whatever the file was. */
function wellFormed(playlist: ParsedPlaylist): void {
  expect(['m3u', 'pls']).toContain(playlist.format)
  expect(playlist.name.length).toBeGreaterThan(0)
  expect(playlist.name.length).toBeLessThanOrEqual(120)
  expect(CONTROL.test(playlist.name)).toBe(false)
  expect(playlist.entries.length).toBeLessThanOrEqual(MAX_ENTRIES)
  expect(playlist.skipped).toBeGreaterThanOrEqual(0)
  for (const entry of playlist.entries) {
    expect(entry.path.length).toBeGreaterThan(0)
    expect(entry.path.length).toBeLessThanOrEqual(1000)
    expect(CONTROL.test(entry.path)).toBe(false)
    expect(STREAM.test(entry.path)).toBe(false)
    expect(entry.title.length).toBeLessThanOrEqual(300)
    expect(entry.artist.length).toBeLessThanOrEqual(300)
    expect(CONTROL.test(entry.title + entry.artist)).toBe(false)
    expect(Number.isFinite(entry.duration)).toBe(true)
    expect(entry.duration).toBeGreaterThanOrEqual(0)
  }
}

const track = (i: number, folder = `Music/Album ${i % 40}`, name = `${String(i % 99).padStart(2, '0')} Song ${i}.mp3`): MatchTrack => ({ id: `t${i}`, title: `Song ${i}`, artist: `Artist ${i % 7}`, path: folder, file: { name } })

describe('reading playlist files under fuzzing', { timeout: FUZZ_TIMEOUT }, () => {
  it('decodes any bytes to text without throwing', async () => {
    await eachSeed(300, (random) => {
      expect(typeof decodePlaylist(randomBytes(random, int(random, 600)))).toBe('string')
      expect(typeof decodePlaylist(mutateBytes(random, new TextEncoder().encode(M3U)))).toBe('string')
      expect(typeof decodePlaylist(Uint8Array.from([0xff, 0xfe, ...randomBytes(random, int(random, 50))]))).toBe('string')
      expect(typeof decodePlaylist(Uint8Array.from([0xfe, 0xff, ...randomBytes(random, int(random, 50))]))).toBe('string')
    })
  })

  it('reads damaged M3U and PLS files into well-formed playlists', async () => {
    await eachSeed(500, (random) => {
      wellFormed(parsePlaylist(mutateText(random, mutateText(random, M3U)), 'mix.m3u8'))
      wellFormed(parsePlaylist(mutateText(random, mutateText(random, PLS)), 'mix.pls'))
    })
  })

  it('reads random text and random bytes into well-formed playlists', async () => {
    await eachSeed(300, (random) => {
      wellFormed(parsePlaylist(randomText(random, int(random, 2000)), pick(random, ['', 'a.m3u', '..\\..\\evil.pls', 'x'.repeat(500)])))
      wellFormed(parsePlaylist(decodePlaylist(randomBytes(random, int(random, 1000)))))
    })
  })

  it('keeps the entries of a good file and skips the streams', () => {
    const m3u = parsePlaylist(M3U)
    expect(m3u.entries.map((e) => e.path)).toEqual(['Music/Rock/01 A Song.mp3', 'C:\\Users\\me\\Music\\02 Other.flac', 'file:///home/me/Music/03%20Third.ogg'])
    expect(m3u.skipped).toBe(1)
    expect(m3u.name).toBe('Road trip')
    const pls = parsePlaylist(PLS)
    expect(pls.entries.map((e) => e.path)).toEqual(['Music/a.mp3', 'Music/c.mp3'])
    expect(pls.skipped).toBe(1)
  })

  const heavy: [string, string][] = [
    ['sixty thousand entries (more than it keeps)', Array.from({ length: 60_000 }, (_, i) => `Music/${i}.mp3`).join('\n')],
    ['five megabytes of one line', 'a'.repeat(5 * 1024 * 1024)],
    ['a hundred thousand tags with no files', '#EXTINF:1,x\n'.repeat(100_000)],
    ['a hundred thousand PLS slots', `[playlist]\n${Array.from({ length: 100_000 }, (_, i) => `File${i}=a${i}.mp3`).join('\n')}`],
    ['PLS numbers that are enormous', `[playlist]\n${Array.from({ length: 5000 }, (_, i) => `File${9_999_999 - i}=a.mp3\nTitle${9_999_999 - i}=x`).join('\n')}`],
    ['quotes that never close', `#EXTINF:1 ${'tvg="'.repeat(100_000)},x\nfile.mp3`],
    ['control characters everywhere', `${'\u0000\u0007\u001b'.repeat(200_000)}\nfile.mp3`],
  ]
  it.each(heavy)('takes a moment at most for %s', (_label, text) => {
    const { result, ms } = timed(() => parsePlaylist(text, 'big.m3u'))
    wellFormed(result)
    expect(ms).toBeLessThan(3000)
  })
})

// ---- the rules as first written: every entry compared with every file of the same name. Slow, simple, and what the fast ----
// ---- version has to agree with.                                                                                      ----
const stemOf = (name: string): string => {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}
const sharedFolders = (a: readonly string[], b: readonly string[]): number => {
  let n = 0
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++
  return n
}
function reference(entries: readonly PlaylistEntry[], tracks: readonly MatchTrack[]): MatchResult {
  const items = tracks.map((t) => ({ id: t.id, folders: pathSegments(t.path), name: fold(t.file.name).trim(), title: fold(t.title).trim(), artist: fold(t.artist).trim() }))
  const ids: string[] = []
  const seen = new Set<string>()
  const missing: PlaylistEntry[] = []
  let duplicates = 0
  for (const entry of entries) {
    const segments = pathSegments(entry.path)
    const name = segments.at(-1) ?? ''
    const title = fold(entry.title).trim()
    const artist = fold(entry.artist).trim()
    const tagged = (item: (typeof items)[number]): boolean => !!title && item.title === title && (!artist || item.artist === artist)
    let candidates = name ? items.filter((i) => i.name === name) : []
    if (name && !candidates.length) candidates = items.filter((i) => stemOf(i.name) === stemOf(name))
    let found: (typeof items)[number] | undefined
    if (candidates.length) {
      const folders = segments.slice(0, -1)
      const best = Math.max(...candidates.map((c) => sharedFolders(folders, c.folders)))
      const top = candidates.filter((c) => sharedFolders(folders, c.folders) === best)
      found = top.find(tagged) ?? top[0]
    } else if (title) {
      const fits = items.filter((i) => i.title && i.title === title && (!artist || i.artist === artist))
      if (fits.length === 1) found = fits[0]
    }
    if (!found) missing.push(entry)
    else if (seen.has(found.id)) duplicates++
    else {
      seen.add(found.id)
      ids.push(found.id)
    }
  }
  return { ids, missing, duplicates }
}

describe('matching playlist entries: the fast version against the plain rules', { timeout: FUZZ_TIMEOUT }, () => {
  const NAMES = ['track.mp3', '01 Intro.mp3', 'Song.FLAC', 'ünal.ogg', 'İstanbul.mp3']
  const FOLDERS = ['', 'Music', 'Music/Rock', 'Music/Pop', 'Rock', 'Pop/Hits', 'Music/Rock/Live', 'Z/Music/Rock', 'Music/Rock/Live/2001']
  const TITLES = ['Intro', 'Song', 'Track', 'İstanbul', 'Another']

  it('agree on libraries full of ties and entries that name them in every way', async () => {
    await eachSeed(400, (random) => {
      const library: MatchTrack[] = Array.from({ length: 5 + int(random, 80) }, (_, i) => ({
        id: `t${i}`,
        title: pick(random, TITLES),
        artist: pick(random, ['A', 'B', '']),
        path: pick(random, FOLDERS),
        file: { name: pick(random, NAMES) },
      }))
      const entries: PlaylistEntry[] = Array.from({ length: int(random, 120) }, () => {
        const folder = pick(random, FOLDERS)
        const name = pick(random, [...NAMES, 'track.flac', 'Intro', 'none.mp3', ''])
        const path = pick(random, [`${folder}/${name}`, `/${folder}/${name}`.toUpperCase(), `C:\\${folder.replace(/\//g, '\\')}\\${name}`, `../${folder}/${name}`, name, `file:///${encodeURI(`${folder}/${name}`)}`])
        return { path, title: random() < 0.5 ? pick(random, TITLES) : '', artist: random() < 0.3 ? pick(random, ['A', 'B']) : '', duration: 0 }
      })
      expect(matchEntries(entries, library)).toEqual(reference(entries, library))
    })
  })
})

describe('matching playlist entries under fuzzing', { timeout: FUZZ_TIMEOUT }, () => {
  const library = Array.from({ length: 120 }, (_, i) => track(i))

  function entryFor(random: Random): PlaylistEntry {
    const t = pick(random, library)
    const base = `${t.path}/${t.file.name}`
    const path = pick(random, [
      base,
      base.toUpperCase(),
      base.replace(/\//g, '\\'),
      `C:\\Users\\me\\${base.replace(/\//g, '\\')}`,
      `file:///home/me/${encodeURI(base)}`,
      `../../${base}`,
      `${base.replace(/\.mp3$/, '.flac')}`,
      t.file.name,
      randomText(random, int(random, 60)),
      mutateText(random, base),
    ])
    return { path, title: random() < 0.5 ? t.title : randomText(random, int(random, 10)), artist: random() < 0.5 ? t.artist : '', duration: 0 }
  }

  it('finds each track at most once, in the order of the playlist, and accounts for every entry', async () => {
    await eachSeed(300, (random) => {
      const entries = Array.from({ length: int(random, 200) }, () => entryFor(random))
      const result = matchEntries(entries, library)
      const known = new Set(library.map((t) => t.id))
      expect(new Set(result.ids).size).toBe(result.ids.length)
      for (const id of result.ids) expect(known.has(id)).toBe(true)
      expect(result.ids.length + result.missing.length + result.duplicates).toBe(entries.length)
      for (const gone of result.missing) expect(entries).toContain(gone)
      expect(matchEntries(entries, library)).toEqual(result)
    })
  })

  it('copes with a library of tracks that share names, and with entries that name nothing', async () => {
    const same = Array.from({ length: 300 }, (_, i) => track(i, `Music/Album ${i}`, 'track.mp3'))
    await eachSeed(100, (random) => {
      const entries = Array.from({ length: 100 }, () => ({ path: pick(random, [`Music/Album ${int(random, 400)}/track.mp3`, 'track.mp3', '', '..', '/', randomText(random, 20)]), title: '', artist: '', duration: 0 }))
      const result = matchEntries(entries, same)
      expect(result.ids.length + result.missing.length + result.duplicates).toBe(entries.length)
    })
  })

  it('stays quick when a great many entries all name a file that many library tracks share', () => {
    // every track of an album-less library called "track.mp3": the folders are the only way to tell them apart
    const tracks = Array.from({ length: 4000 }, (_, i) => track(i, `Music/Album ${i}`, 'track.mp3'))
    const entries = Array.from({ length: 20_000 }, (_, i) => ({ path: `Music/Album ${i % 5000}/track.mp3`, title: '', artist: '', duration: 0 }))
    const { result, ms } = timed(() => matchEntries(entries, tracks))
    expect(result.ids.length + result.missing.length + result.duplicates).toBe(entries.length)
    expect(result.ids).toHaveLength(4000)
    expect(ms).toBeLessThan(4000)
  })

  it('stays quick with the most entries a file may hold against a big library', () => {
    const tracks = Array.from({ length: 20_000 }, (_, i) => track(i))
    const entries = Array.from({ length: MAX_ENTRIES }, (_, i) => ({ path: `Music/Album ${i % 40}/${String(i % 99).padStart(2, '0')} Song ${i % 20_000}.mp3`, title: '', artist: '', duration: 0 }))
    const { result, ms } = timed(() => matchEntries(entries, tracks))
    expect(result.ids.length + result.missing.length + result.duplicates).toBe(entries.length)
    expect(ms).toBeLessThan(6000)
  })
})
