import { describe, expect, it } from 'vitest'
import { seededRandom } from './dsp'
import { MAX_ENTRIES, decodePlaylist, entryPath, isPlaylistFile, matchEntries, parsePlaylist, pathSegments, playlistFileName, serializeM3u, serializePls } from './playlistfiles'
import type { MatchTrack, PlaylistEntry } from './playlistfiles'

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text)
const entry = (path: string, over: Partial<PlaylistEntry> = {}): PlaylistEntry => ({ path, title: '', artist: '', duration: 0, ...over })

describe('decodePlaylist', () => {
  it('reads UTF-8 and drops a byte order mark', () => {
    expect(decodePlaylist(utf8('\uFEFF#EXTM3U\nİstanbul.mp3'))).toBe('#EXTM3U\nİstanbul.mp3')
    expect(decodePlaylist(utf8('Şebnem Ferah.mp3'))).toBe('Şebnem Ferah.mp3')
  })

  it('falls back to Windows-1252 for old files that are not UTF-8', () => {
    expect(decodePlaylist(Uint8Array.from([0x63, 0x61, 0x66, 0xe9, 0x2e, 0x6d, 0x70, 0x33]))).toBe('café.mp3')
  })

  it('reads UTF-16 with a byte order mark, either way round', () => {
    const le = [0xff, 0xfe, ...[...'a.mp3'].flatMap((c) => [c.charCodeAt(0), 0])]
    const be = [0xfe, 0xff, ...[...'a.mp3'].flatMap((c) => [0, c.charCodeAt(0)])]
    expect(decodePlaylist(Uint8Array.from(le))).toBe('a.mp3')
    expect(decodePlaylist(Uint8Array.from(be))).toBe('a.mp3')
  })

  it('reads nothing as nothing', () => {
    expect(decodePlaylist(new Uint8Array(0))).toBe('')
  })
})

describe('isPlaylistFile', () => {
  it('knows the playlist file extensions, in any case', () => {
    for (const name of ['a.m3u', 'a.M3U8', 'dir/b.pls', 'c.PLS']) expect(isPlaylistFile(name), name).toBe(true)
    for (const name of ['a.mp3', 'a.m3u.txt', 'a', 'm3u', 'a.pls.bak']) expect(isPlaylistFile(name), name).toBe(false)
  })
})

describe('parsePlaylist: M3U', () => {
  const text = [
    '#EXTM3U',
    '#PLAYLIST:Road Trip',
    '#EXTINF:215,The Beatles - Help!',
    'Music/Beatles/Help.mp3',
    '#EXTINF:-1,Untitled',
    'C:\\Music\\other.flac',
    '',
    '# a comment',
    '"quoted name.mp3"',
    'http://radio.example/stream',
    'file:///home/me/Music/My%20Song.mp3',
  ].join('\n')

  it('reads the entries in order, with what #EXTINF says about each', () => {
    const parsed = parsePlaylist(text, 'whatever.m3u8')
    expect(parsed.format).toBe('m3u')
    expect(parsed.entries).toEqual([
      { path: 'Music/Beatles/Help.mp3', title: 'Help!', artist: 'The Beatles', duration: 215 },
      { path: 'C:\\Music\\other.flac', title: 'Untitled', artist: '', duration: 0 },
      { path: 'quoted name.mp3', title: '', artist: '', duration: 0 },
      { path: 'file:///home/me/Music/My%20Song.mp3', title: '', artist: '', duration: 0 },
    ])
  })

  it('takes the name from #PLAYLIST, else from the file name, else a default', () => {
    expect(parsePlaylist(text, 'x.m3u').name).toBe('Road Trip')
    expect(parsePlaylist('a.mp3', 'Summer 2024.m3u8').name).toBe('Summer 2024')
    expect(parsePlaylist('a.mp3').name).toBe('Imported playlist')
    expect(parsePlaylist('a.mp3', '.m3u').name).toBe('Imported playlist')
  })

  it('skips streams (they are not on this device) and says how many', () => {
    const parsed = parsePlaylist(text, 'x.m3u')
    expect(parsed.skipped).toBe(1)
    expect(parsed.entries.some((e) => e.path.startsWith('http'))).toBe(false)
  })

  it('reads line endings of every kind, and a byte order mark that decoding left in', () => {
    const parsed = parsePlaylist('\uFEFF#EXTM3U\r\na.mp3\rb.mp3\n\nc.mp3\r\n', 'x.m3u')
    expect(parsed.entries.map((e) => e.path)).toEqual(['a.mp3', 'b.mp3', 'c.mp3'])
  })

  it('understands #EXTINF with attributes, decimal and negative lengths, and a dash in the title', () => {
    const parsed = parsePlaylist(['#EXTINF:-1 tvg-id="x" tvg-name="y",Plain Name', 'a.mp3', '#EXTINF:12.6,Band - Song - Live', 'b.mp3', '#EXTINF:abc,Junk', 'c.mp3'].join('\n'), 'x.m3u')
    expect(parsed.entries).toEqual([
      { path: 'a.mp3', title: 'Plain Name', artist: '', duration: 0 },
      { path: 'b.mp3', title: 'Song - Live', artist: 'Band', duration: 12.6 },
      { path: 'c.mp3', title: 'Junk', artist: '', duration: 0 },
    ])
  })

  it('gives #EXTINF to the next entry only', () => {
    const parsed = parsePlaylist(['#EXTINF:100,Band - One', 'a.mp3', 'b.mp3'].join('\n'), 'x.m3u')
    expect(parsed.entries[1]).toEqual({ path: 'b.mp3', title: '', artist: '', duration: 0 })
  })

  it('removes control characters and caps how long a path or a title can be', () => {
    const parsed = parsePlaylist([`#EXTINF:1,${'T'.repeat(1000)}`, `a\u0000b\u0007.mp3`, `${'p'.repeat(5000)}.mp3`].join('\n'), 'x.m3u')
    expect(parsed.entries[0]?.path).toBe('a b .mp3')
    expect(parsed.entries[0]?.title).toHaveLength(300)
    expect(parsed.entries[1]?.path.length).toBeLessThanOrEqual(1000)
  })

  it('stops at the entry limit and counts what it did not read', () => {
    const parsed = parsePlaylist(Array.from({ length: MAX_ENTRIES + 3 }, (_, i) => `t${i}.mp3`).join('\n'), 'x.m3u')
    expect(parsed.entries).toHaveLength(MAX_ENTRIES)
    expect(parsed.skipped).toBe(3)
  })

  it('is empty for nothing useful', () => {
    expect(parsePlaylist('', 'x.m3u').entries).toEqual([])
    expect(parsePlaylist('#EXTM3U\n# just comments\n\n', 'x.m3u').entries).toEqual([])
  })
})

describe('parsePlaylist: PLS', () => {
  const text = ['[playlist]', 'NumberOfEntries=3', 'File2=C:\\Music\\b.mp3', 'Title2=Beta', 'Length2=120', 'File1=Music/a.mp3', 'Title1=Band - Alpha', 'Length1=-1', 'File3=', 'Version=2'].join('\r\n')

  it('reads the entries in their numbered order, whatever order the lines are in', () => {
    const parsed = parsePlaylist(text, 'mix.pls')
    expect(parsed.format).toBe('pls')
    expect(parsed.name).toBe('mix')
    expect(parsed.entries).toEqual([
      { path: 'Music/a.mp3', title: 'Alpha', artist: 'Band', duration: 0 },
      { path: 'C:\\Music\\b.mp3', title: 'Beta', artist: '', duration: 120 },
    ])
  })

  it('counts an entry with no file as skipped', () => {
    expect(parsePlaylist(text, 'mix.pls').skipped).toBe(1)
  })

  it('reads keys in any case and tells a PLS by its content, whatever the file is called', () => {
    const parsed = parsePlaylist('[Playlist]\nfile1=a.mp3\nTITLE1=A\nlength1=5', 'noextension')
    expect(parsed.format).toBe('pls')
    expect(parsed.entries).toEqual([{ path: 'a.mp3', title: 'A', artist: '', duration: 5 }])
  })

  it('ignores streams, as in an M3U', () => {
    const parsed = parsePlaylist('[playlist]\nFile1=http://x.example/a\nFile2=b.mp3', 'x.pls')
    expect(parsed.entries.map((e) => e.path)).toEqual(['b.mp3'])
    expect(parsed.skipped).toBe(1)
  })
})

describe('pathSegments', () => {
  it('turns Windows paths, drive letters and backslashes into plain folded segments', () => {
    expect(pathSegments('C:\\Music\\Rock\\İstanbul.mp3')).toEqual(['music', 'rock', 'istanbul.mp3'])
  })

  it('reads file URLs and percent-encoding', () => {
    expect(pathSegments('file:///C:/Music/Rock/My%20Song.mp3')).toEqual(['music', 'rock', 'my song.mp3'])
    expect(pathSegments('file://localhost/home/me/a.mp3')).toEqual(['home', 'me', 'a.mp3'])
  })

  it('keeps text that is not valid percent-encoding as it is', () => {
    expect(pathSegments('a%zz.mp3')).toEqual(['a%zz.mp3'])
  })

  it('resolves dot segments and collapses repeated separators', () => {
    expect(pathSegments('./music/../music/./a.mp3')).toEqual(['music', 'a.mp3'])
    expect(pathSegments('Music//Rock///a.mp3')).toEqual(['music', 'rock', 'a.mp3'])
    expect(pathSegments('../../a.mp3')).toEqual(['a.mp3'])
  })

  it('treats a network path and a Unix path alike', () => {
    expect(pathSegments('\\\\server\\share\\Music\\a.mp3')).toEqual(['server', 'share', 'music', 'a.mp3'])
    expect(pathSegments('/home/me/Music/a.mp3')).toEqual(['home', 'me', 'music', 'a.mp3'])
  })

  it('compares accents and Unicode forms as search does', () => {
    expect(pathSegments('Café/Ünal.mp3')).toEqual(pathSegments('Cafe\u0301/U\u0308nal.mp3'))
  })

  it('is empty for nothing', () => {
    expect(pathSegments('')).toEqual([])
    expect(pathSegments('   ')).toEqual([])
  })
})

describe('matchEntries', () => {
  const track = (id: string, path: string, file: string, title = '', artist = ''): MatchTrack => ({ id, path, file: { name: file }, title, artist })
  const library = [
    track('t1', 'Music/Rock/Album', '01 Intro.mp3', 'Intro', 'Band'),
    track('t2', 'Music/Rock/Album', '02 Song.mp3', 'Song', 'Band'),
    track('t3', 'Music/Pop/Album', '02 Song.mp3', 'Song', 'Other'),
    track('t4', '', 'Şarkı.mp3', 'Şarkı', 'Tarkan'),
    track('t5', 'Music/Jazz', 'blue.flac', 'Blue', 'Miles'),
  ]
  const match = (...entries: PlaylistEntry[]) => matchEntries(entries, library)

  it('finds a track by its path in the library', () => {
    expect(match(entry('Music/Rock/Album/01 Intro.mp3')).ids).toEqual(['t1'])
  })

  it('finds it by a longer absolute path, telling apart the same file name in different folders', () => {
    expect(match(entry('D:\\Backup\\Music\\Rock\\Album\\02 Song.mp3')).ids).toEqual(['t2'])
    expect(match(entry('E:\\Music\\Pop\\Album\\02 Song.mp3')).ids).toEqual(['t3'])
  })

  it('finds it by file name alone, the first in the library when several have it', () => {
    expect(match(entry('01 Intro.mp3')).ids).toEqual(['t1'])
    expect(match(entry('02 Song.mp3')).ids).toEqual(['t2'])
  })

  it('does not mind case, accents or the Turkish dotless i', () => {
    expect(match(entry('music/rock/album/01 INTRO.MP3')).ids).toEqual(['t1'])
    expect(match(entry('SARKI.MP3')).ids).toEqual(['t4'])
    expect(match(entry('Şarkı.mp3')).ids).toEqual(['t4'])
  })

  it('finds a track whose file was converted to another format', () => {
    expect(match(entry('Music/Jazz/blue.mp3')).ids).toEqual(['t5'])
  })

  it('reads file URLs and percent-encoding', () => {
    expect(match(entry('file:///music/jazz/Blue.flac')).ids).toEqual(['t5'])
    expect(match(entry('Music/Rock/Album/01%20Intro.mp3')).ids).toEqual(['t1'])
  })

  it('falls back to the title and artist the playlist gives when no file name fits', () => {
    expect(match(entry('lost/place/x.mp3', { title: 'Intro', artist: 'Band' })).ids).toEqual(['t1'])
    expect(match(entry('lost/place/x.mp3', { title: 'Intro' })).ids).toEqual(['t1'])
    expect(match(entry('lost/place/x.mp3', { title: 'Song', artist: 'Other' })).ids).toEqual(['t3'])
  })

  it('does not guess between tracks when the title alone is ambiguous', () => {
    const result = match(entry('lost/x.mp3', { title: 'Song' }))
    expect(result.ids).toEqual([])
    expect(result.missing).toHaveLength(1)
  })

  it('keeps the order of the playlist and lists what it could not find', () => {
    const result = match(entry('Music/Jazz/blue.flac'), entry('gone/one.mp3'), entry('Music/Rock/Album/01 Intro.mp3'), entry('gone/two.mp3'))
    expect(result.ids).toEqual(['t5', 't1'])
    expect(result.missing.map((e) => e.path)).toEqual(['gone/one.mp3', 'gone/two.mp3'])
  })

  it('names a track once however often the playlist lists it, and counts the repeats', () => {
    const result = match(entry('01 Intro.mp3'), entry('Music/Rock/Album/01 Intro.mp3'), entry('Music/Jazz/blue.flac'))
    expect(result.ids).toEqual(['t1', 't5'])
    expect(result.duplicates).toBe(1)
  })

  it('has nothing to say about an empty playlist or an empty library', () => {
    expect(matchEntries([], library)).toEqual({ ids: [], missing: [], duplicates: 0 })
    const none = matchEntries([entry('a.mp3')], [])
    expect(none.ids).toEqual([])
    expect(none.missing).toHaveLength(1)
  })

  it('matches thousands of entries against tens of thousands of tracks quickly', () => {
    const big = Array.from({ length: 20_000 }, (_, i) => track(`b${i}`, `Music/Folder ${i % 200}`, `Song ${i}.mp3`, `Song ${i}`, `Artist ${i % 300}`))
    const entries = Array.from({ length: 5_000 }, (_, i) => entry(`D:\\Backup\\Music\\Folder ${(i * 7) % 200}\\Song ${i * 4}.mp3`))
    const started = performance.now()
    const result = matchEntries(entries, big)
    expect(performance.now() - started).toBeLessThan(1500)
    expect(result.ids.length + result.missing.length + result.duplicates).toBe(5_000)
    expect(result.ids.length).toBeGreaterThan(1000)
  })
})

describe('serializing', () => {
  const items = [
    { path: 'Music/a.mp3', title: 'Alpha', artist: 'Band', duration: 215.4 },
    { path: 'b.mp3', title: 'Beta', artist: 'Unknown Artist', duration: 0 },
  ]

  it('writes an extended M3U with the length, artist and title of each track', () => {
    expect(serializeM3u('Road Trip', items)).toBe(['#EXTM3U', '#PLAYLIST:Road Trip', '#EXTINF:215,Band - Alpha', 'Music/a.mp3', '#EXTINF:-1,Beta', 'b.mp3', ''].join('\n'))
  })

  it('writes a PLS', () => {
    expect(serializePls(items)).toBe(['[playlist]', 'File1=Music/a.mp3', 'Title1=Band - Alpha', 'Length1=215', 'File2=b.mp3', 'Title2=Beta', 'Length2=-1', 'NumberOfEntries=2', 'Version=2', ''].join('\n'))
  })

  it('cannot be made to write extra lines by what a title or name contains', () => {
    const text = serializeM3u('Mix\n#EXTINF:1,Evil', [{ path: 'a.mp3', title: 'Line\r\nbreak', artist: 'A\nB', duration: 1 }])
    expect(text.split('\n').filter((l) => l.startsWith('#EXTINF'))).toHaveLength(1)
    expect(text.split(/\r?\n/)).toHaveLength(5) // header, name, #EXTINF, path, and the empty piece after the last newline
    expect(serializePls([{ path: 'a.mp3', title: 'x\ny', artist: '', duration: 1 }]).split('\n').filter((l) => l.startsWith('Title1='))).toEqual(['Title1=x y'])
  })

  it('reads back as the same tracks: what is written can be imported and matched again', () => {
    const library = [
      { id: 't1', path: 'Music/Rock', file: { name: 'a.mp3' }, title: 'Alpha', artist: 'Band' },
      { id: 't2', path: '', file: { name: 'b.mp3' }, title: 'Beta', artist: '' },
    ]
    const exported = library.map((t) => ({ path: entryPath(t.path, t.file.name), title: t.title, artist: t.artist, duration: 100 }))
    for (const text of [serializeM3u('Mix', exported), serializePls(exported)]) {
      const parsed = parsePlaylist(text, 'Mix.m3u8')
      expect(matchEntries(parsed.entries, library).ids).toEqual(['t1', 't2'])
    }
  })
})

describe('entryPath and playlistFileName', () => {
  it('joins a folder and a file name with a forward slash, with none for loose files', () => {
    expect(entryPath('Music/Rock', 'a.mp3')).toBe('Music/Rock/a.mp3')
    expect(entryPath('', 'a.mp3')).toBe('a.mp3')
  })

  it('makes a name safe to save as a file', () => {
    expect(playlistFileName('Road/Trip: 2024?', 'm3u8')).toBe('Road_Trip_ 2024_.m3u8')
    expect(playlistFileName('  ', 'pls')).toBe('playlist.pls')
    expect(playlistFileName('x'.repeat(300), 'm3u8').length).toBeLessThanOrEqual(110)
    expect(playlistFileName('Şebnem', 'm3u8')).toBe('Şebnem.m3u8')
  })
})

describe('untrusted input', () => {
  const pieces = ['#EXTM3U', '#EXTINF:', '#PLAYLIST:', '[playlist]', 'File1=', 'Title1=', 'Length1=', '\n', '\r', '\r\n', 'http://', 'file:///', 'C:\\', '%zz', '%41', '..', '/', '\\', '\u0000', '\u0007', 'é', 'İ', ',', ' - ', '"', "'", '=', 'a.mp3', 'x'.repeat(2000), '-1', '3.5', 'NumberOfEntries=999999999', '\uFEFF']

  it('never throws and never returns anything that breaks the limits, whatever it is fed', () => {
    const random = seededRandom(20260416)
    const library: MatchTrack[] = [{ id: 't1', path: 'Music', file: { name: 'a.mp3' }, title: 'A', artist: 'B' }]
    for (let i = 0; i < 300; i++) {
      const text = Array.from({ length: 1 + Math.floor(random() * 40) }, () => pieces[Math.floor(random() * pieces.length)] ?? '').join(random() < 0.5 ? '' : '\n')
      const parsed = parsePlaylist(text, random() < 0.3 ? 'x.pls' : 'x.m3u8')
      expect(parsed.entries.length).toBeLessThanOrEqual(MAX_ENTRIES)
      for (const e of parsed.entries) {
        expect(e.path.length).toBeLessThanOrEqual(1000)
        expect(e.title.length).toBeLessThanOrEqual(300)
        expect(/[\u0000-\u001f\u007f]/.test(e.path + e.title + e.artist)).toBe(false)
        expect(Number.isFinite(e.duration)).toBe(true)
        expect(e.duration).toBeGreaterThanOrEqual(0)
      }
      const result = matchEntries(parsed.entries, library)
      expect(result.ids.length + result.missing.length + result.duplicates).toBe(parsed.entries.length)
    }
  })

  it('decodes any bytes without throwing', () => {
    const random = seededRandom(7)
    for (let i = 0; i < 200; i++) {
      const bytes = Uint8Array.from({ length: Math.floor(random() * 200) }, () => Math.floor(random() * 256))
      expect(typeof decodePlaylist(bytes)).toBe('string')
    }
  })
})
