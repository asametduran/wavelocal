/** Pure folder-tree model for the library's "Folders" view. Contains no DOM or React code. */

/** The folder part of a relative file path, normalized to `a/b/c` ('' for loose files). */
export function folderOf(relativePath: string | null | undefined): string {
  if (!relativePath) return ''
  const parts = relativePath
    .split(/[\\/]+/)
    .map((s) => s.trim())
    .filter((s) => s !== '' && s !== '.' && s !== '..')
  parts.pop() // the file name itself
  return parts.join('/')
}

/** Normalize an already folder-only path (as stored on tracks). */
export function cleanFolderPath(path: string | null | undefined): string {
  return folderOf(path ? `${path}/x` : '')
}

/** The minimum a track needs to be placed in the tree. */
export interface FolderTrack {
  id: string
  path: string
}

export interface FolderNode {
  /** Last path segment ('' for the root). */
  name: string
  /** Full path from the root, '/'-separated ('' for the root). */
  path: string
  folders: FolderNode[]
  /** Tracks stored directly in this folder, in library order. */
  trackIds: string[]
  /** Tracks in this folder and every folder below it. */
  count: number
}

export type FolderRow =
  | { kind: 'folder'; node: FolderNode; depth: number; open: boolean }
  | { kind: 'track'; id: string; depth: number }

const byName = (a: FolderNode, b: FolderNode): number => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })

const parentOf = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')

/** Group tracks into a folder tree. Folders sort naturally by name; tracks keep the order they were given. */
export function buildTree(tracks: readonly FolderTrack[]): FolderNode {
  const root: FolderNode = { name: '', path: '', folders: [], trackIds: [], count: 0 }
  const index = new Map<string, FolderNode>([['', root]])

  const ensure = (path: string): FolderNode => {
    const hit = index.get(path)
    if (hit) return hit
    const parent = ensure(parentOf(path))
    const node: FolderNode = { name: path.slice(path.lastIndexOf('/') + 1), path, folders: [], trackIds: [], count: 0 }
    parent.folders.push(node)
    index.set(path, node)
    return node
  }

  for (const t of tracks) {
    const path = cleanFolderPath(t.path)
    ensure(path).trackIds.push(t.id)
    for (let p = path; ; p = parentOf(p)) {
      const n = index.get(p)
      if (n) n.count++
      if (p === '') break
    }
  }
  for (const n of index.values()) n.folders.sort(byName)
  return root
}

/**
 * While nothing is stored, show the top-level folders opened one level (their sub-folders collapsed), so a
 * freshly imported folder reveals its contents without flooding the list.
 */
export function defaultOpen(root: FolderNode): Set<string> {
  return new Set(root.folders.map((f) => f.path))
}

/**
 * Walk the tree into the rows that are currently visible. Within a folder, sub-folders come first, then tracks.
 * `forceOpen` shows everything expanded (used while searching).
 */
export function flattenTree(root: FolderNode, open: ReadonlySet<string>, forceOpen = false): FolderRow[] {
  const rows: FolderRow[] = []
  const walk = (node: FolderNode, depth: number): void => {
    for (const f of node.folders) {
      const isOpen = forceOpen || open.has(f.path)
      rows.push({ kind: 'folder', node: f, depth, open: isOpen })
      if (isOpen) walk(f, depth + 1)
    }
    for (const id of node.trackIds) rows.push({ kind: 'track', id, depth })
  }
  walk(root, 0)
  return rows
}

/** Every track id at or below a folder, in the order the tree shows them (sub-folders first). */
export function collectTrackIds(node: FolderNode): string[] {
  const out: string[] = []
  const walk = (n: FolderNode): void => {
    n.folders.forEach(walk)
    out.push(...n.trackIds)
  }
  walk(node)
  return out
}

/** Find a folder by its path. */
export function findFolder(root: FolderNode, path: string): FolderNode | null {
  if (path === '') return root
  let node = root
  for (const seg of path.split('/')) {
    const next = node.folders.find((f) => f.name === seg)
    if (!next) return null
    node = next
  }
  return node
}

/** Paths of every folder above `path`, outermost first: `a/b/c` → `a`, `a/b`. */
export function ancestorsOf(path: string): string[] {
  const parts = path.split('/').filter(Boolean)
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'))
}

/** Drop open-folder paths that no longer exist (e.g. after their tracks were removed). */
export function pruneOpen(open: ReadonlySet<string>, root: FolderNode): Set<string> {
  return new Set([...open].filter((p) => findFolder(root, p) !== null))
}
