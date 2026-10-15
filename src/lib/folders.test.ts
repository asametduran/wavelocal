import { describe, expect, it } from 'vitest'
import { ancestorsOf, buildTree, cleanFolderPath, collectTrackIds, defaultOpen, findFolder, flattenTree, folderOf, pruneOpen } from './folders'
import type { FolderRow } from './folders'

const t = (id: string, path: string) => ({ id, path })

const label = (rows: FolderRow[]): string[] => rows.map((r) => `${'  '.repeat(r.depth)}${r.kind === 'folder' ? `${r.node.name}/ (${r.node.count})` : r.id}`)

describe('folderOf', () => {
  it('drops the file name and keeps the folders', () => {
    expect(folderOf('Music/Rock/a.mp3')).toBe('Music/Rock')
    expect(folderOf('a.mp3')).toBe('')
    expect(folderOf('')).toBe('')
    expect(folderOf(null)).toBe('')
    expect(folderOf(undefined)).toBe('')
  })

  it('accepts Windows separators and collapses repeats', () => {
    expect(folderOf('Music\\Rock\\a.mp3')).toBe('Music/Rock')
    expect(folderOf('Music//Rock///a.mp3')).toBe('Music/Rock')
  })

  it('never lets a path climb out of the root', () => {
    expect(folderOf('../../etc/a.mp3')).toBe('etc')
    expect(folderOf('./Music/./a.mp3')).toBe('Music')
    expect(folderOf('/Music/a.mp3')).toBe('Music')
  })
})

describe('cleanFolderPath', () => {
  it('normalizes a folder-only path and is idempotent', () => {
    expect(cleanFolderPath('Music\\Rock/')).toBe('Music/Rock')
    expect(cleanFolderPath(cleanFolderPath('/a//b/'))).toBe('a/b')
    expect(cleanFolderPath('')).toBe('')
    expect(cleanFolderPath(undefined)).toBe('')
  })
})

describe('buildTree', () => {
  const tracks = [t('1', 'Music/Rock/Album 2'), t('2', 'Music/Rock/Album 10'), t('3', 'Music/Rock/Album 1'), t('4', 'Music'), t('5', ''), t('6', 'Podcasts')]
  const root = buildTree(tracks)

  it('nests folders and counts every track below them', () => {
    expect(root.count).toBe(6)
    expect(root.trackIds).toEqual(['5'])
    expect(root.folders.map((f) => f.name)).toEqual(['Music', 'Podcasts'])
    const music = findFolder(root, 'Music')
    expect(music?.count).toBe(4)
    expect(music?.trackIds).toEqual(['4'])
    expect(findFolder(root, 'Music/Rock')?.count).toBe(3)
  })

  it('sorts sibling folders naturally (2 before 10)', () => {
    expect(findFolder(root, 'Music/Rock')?.folders.map((f) => f.name)).toEqual(['Album 1', 'Album 2', 'Album 10'])
  })

  it('keeps the given track order inside a folder', () => {
    const r = buildTree([t('z', 'A'), t('y', 'A'), t('x', 'A')])
    expect(findFolder(r, 'A')?.trackIds).toEqual(['z', 'y', 'x'])
  })

  it('creates intermediate folders that hold no tracks themselves', () => {
    const r = buildTree([t('1', 'a/b/c')])
    expect(findFolder(r, 'a')?.trackIds).toEqual([])
    expect(findFolder(r, 'a')?.count).toBe(1)
    expect(findFolder(r, 'a/b/c')?.trackIds).toEqual(['1'])
  })

  it('treats a folder named like a prefix of another as a different folder', () => {
    const r = buildTree([t('1', 'Rock'), t('2', 'Rock Ballads')])
    expect(r.folders.map((f) => [f.name, f.count])).toEqual([
      ['Rock', 1],
      ['Rock Ballads', 1],
    ])
  })

  it('is empty for no tracks', () => {
    const r = buildTree([])
    expect(r).toEqual({ name: '', path: '', folders: [], trackIds: [], count: 0 })
    expect(flattenTree(r, new Set())).toEqual([])
  })

  it('tolerates un-normalized stored paths', () => {
    const r = buildTree([t('1', 'Music\\Rock/')])
    expect(findFolder(r, 'Music/Rock')?.trackIds).toEqual(['1'])
  })
})

describe('flattenTree', () => {
  const root = buildTree([t('1', 'Music/Rock'), t('2', 'Music/Rock'), t('3', 'Music/Jazz'), t('4', 'Music'), t('5', '')])

  it('shows only the top level while everything is collapsed', () => {
    expect(label(flattenTree(root, new Set()))).toEqual(['Music/ (4)', '5'])
  })

  it('lists sub-folders before tracks inside an open folder', () => {
    expect(label(flattenTree(root, new Set(['Music'])))).toEqual(['Music/ (4)', '  Jazz/ (1)', '  Rock/ (2)', '  4', '5'])
  })

  it('expands nested folders only when each ancestor is open', () => {
    expect(label(flattenTree(root, new Set(['Music/Rock'])))).toEqual(['Music/ (4)', '5']) // parent closed: child hidden
    expect(label(flattenTree(root, new Set(['Music', 'Music/Rock'])))).toEqual(['Music/ (4)', '  Jazz/ (1)', '  Rock/ (2)', '    1', '    2', '  4', '5'])
  })

  it('forceOpen expands everything regardless of the open set', () => {
    const rows = flattenTree(root, new Set(), true)
    expect(rows.flatMap((r) => (r.kind === 'track' ? [r.id] : []))).toEqual(['3', '1', '2', '4', '5'])
    expect(rows.every((r) => r.kind === 'track' || r.open)).toBe(true)
  })
})

describe('defaultOpen', () => {
  it('opens the top-level folders only', () => {
    const root = buildTree([t('1', 'A/B'), t('2', 'C')])
    expect([...defaultOpen(root)].sort()).toEqual(['A', 'C'])
  })
})

describe('collectTrackIds', () => {
  it('returns every track below a folder in display order', () => {
    const root = buildTree([t('1', 'M/Rock'), t('2', 'M'), t('3', 'M/Jazz'), t('4', 'Other')])
    expect(collectTrackIds(findFolder(root, 'M') ?? root)).toEqual(['3', '1', '2'])
    expect(collectTrackIds(root)).toEqual(['3', '1', '2', '4'])
  })
})

describe('findFolder / ancestorsOf / pruneOpen', () => {
  const root = buildTree([t('1', 'a/b/c')])

  it('finds folders by path and returns null for unknown ones', () => {
    expect(findFolder(root, 'a/b')?.name).toBe('b')
    expect(findFolder(root, '')).toBe(root)
    expect(findFolder(root, 'a/x')).toBeNull()
  })

  it('lists the folders above a path, outermost first', () => {
    expect(ancestorsOf('a/b/c')).toEqual(['a', 'a/b'])
    expect(ancestorsOf('a')).toEqual([])
    expect(ancestorsOf('')).toEqual([])
  })

  it('forgets open folders that no longer exist', () => {
    expect([...pruneOpen(new Set(['a', 'a/b', 'gone', 'a/gone']), root)].sort()).toEqual(['a', 'a/b'])
  })
})
