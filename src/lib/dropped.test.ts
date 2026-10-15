import { describe, expect, it } from 'vitest'
import { filesFromDrop, walkEntry } from './dropped'

type Node = { name: string } | { name: string; children: Node[] }

/** A minimal fake of the FileSystemEntry tree; directories return their children in batches of `batch`. */
function fakeEntry(node: Node, batch = 2): FileSystemEntry {
  if ('children' in node) {
    return {
      isFile: false,
      isDirectory: true,
      name: node.name,
      createReader: () => {
        let at = 0
        return {
          readEntries: (ok: (e: FileSystemEntry[]) => void) => {
            const next = node.children.slice(at, at + batch).map((c) => fakeEntry(c, batch))
            at += batch
            ok(next)
          },
        }
      },
    } as unknown as FileSystemEntry
  }
  return {
    isFile: true,
    isDirectory: false,
    name: node.name,
    file: (ok: (f: File) => void) => ok(new File(['x'], node.name, { type: 'audio/mpeg' })),
  } as unknown as FileSystemEntry
}

const paths = (files: File[]): string[] => files.map((f) => f.webkitRelativePath)

describe('walkEntry', () => {
  it('gives files inside a dropped folder their relative path', async () => {
    const tree: Node = { name: 'Music', children: [{ name: 'a.mp3' }, { name: 'Rock', children: [{ name: 'b.mp3' }] }] }
    expect(paths(await walkEntry(fakeEntry(tree)))).toEqual(['Music/a.mp3', 'Music/Rock/b.mp3'])
  })

  it('keeps a loose dropped file path-free', async () => {
    const files = await walkEntry(fakeEntry({ name: 'solo.mp3' }))
    expect(files.map((f) => [f.name, f.webkitRelativePath || ''])).toEqual([['solo.mp3', '']])
  })

  it('reads directories that need several readEntries batches', async () => {
    const children = Array.from({ length: 7 }, (_, i) => ({ name: `t${i}.mp3` }))
    const files = await walkEntry(fakeEntry({ name: 'Big', children }, 3))
    expect(files).toHaveLength(7)
  })

  it('walks siblings in natural name order', async () => {
    const tree: Node = { name: 'M', children: [{ name: 'track 10.mp3' }, { name: 'track 2.mp3' }, { name: 'track 1.mp3' }] }
    expect((await walkEntry(fakeEntry(tree))).map((f) => f.name)).toEqual(['track 1.mp3', 'track 2.mp3', 'track 10.mp3'])
  })

  it('skips unreadable files and unreadable directories instead of failing the drop', async () => {
    const bad = { isFile: true, isDirectory: false, name: 'bad.mp3', file: (_ok: unknown, fail: () => void) => fail() } as unknown as FileSystemEntry
    const badDir = {
      isFile: false,
      isDirectory: true,
      name: 'locked',
      createReader: () => ({ readEntries: (_ok: unknown, fail: () => void) => fail() }),
    } as unknown as FileSystemEntry
    const dir = {
      isFile: false,
      isDirectory: true,
      name: 'M',
      createReader: () => {
        let done = false
        return {
          readEntries: (ok: (e: FileSystemEntry[]) => void) => {
            ok(done ? [] : [bad, badDir, fakeEntry({ name: 'good.mp3' })])
            done = true
          },
        }
      },
    } as unknown as FileSystemEntry
    expect(paths(await walkEntry(dir))).toEqual(['M/good.mp3'])
  })

  it('stops descending past the depth limit', async () => {
    let node: Node = { name: 'leaf.mp3' }
    for (let i = 0; i < 60; i++) node = { name: `d${i}`, children: [node] }
    expect(await walkEntry(fakeEntry(node))).toEqual([])
  })
})

describe('filesFromDrop', () => {
  const item = (entry: FileSystemEntry | null, file: File | null) => ({
    kind: 'file',
    webkitGetAsEntry: () => entry,
    getAsFile: () => file,
  })

  it('returns [] without a DataTransfer', async () => {
    expect(await filesFromDrop(null)).toEqual([])
  })

  it('expands dropped folders and keeps loose files', async () => {
    const loose = new File(['x'], 'loose.mp3')
    const dt = { items: [item(fakeEntry({ name: 'Album', children: [{ name: 'a.mp3' }] }), null), item(null, loose)], files: [] } as unknown as DataTransfer
    const files = await filesFromDrop(dt)
    expect(files.map((f) => f.webkitRelativePath || f.name)).toEqual(['Album/a.mp3', 'loose.mp3'])
  })

  it('falls back to dataTransfer.files when the browser exposes no items', async () => {
    const f = new File(['x'], 'a.mp3')
    expect(await filesFromDrop({ items: [], files: [f] } as unknown as DataTransfer)).toEqual([f])
  })

  it('ignores non-file items such as dragged text', async () => {
    const dt = { items: [{ kind: 'string' }], files: [] } as unknown as DataTransfer
    expect(await filesFromDrop(dt)).toEqual([])
  })

  it('captures entries synchronously, before the DataTransfer is invalidated', async () => {
    const calls: string[] = []
    const dt = {
      items: [
        {
          kind: 'file',
          webkitGetAsEntry: () => (calls.push('entry'), fakeEntry({ name: 'a.mp3' })),
          getAsFile: () => (calls.push('file'), null),
        },
      ],
      files: [],
    } as unknown as DataTransfer
    const pending = filesFromDrop(dt)
    expect(calls).toEqual(['entry', 'file']) // both read before the promise is awaited
    await pending
  })
})
