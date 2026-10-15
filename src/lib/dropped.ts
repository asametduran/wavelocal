/**
 * Read files out of a drag-and-drop, including whole folders.
 *
 * `DataTransfer.files` lists a dropped folder as a single empty pseudo-file, so folders have to be walked through the
 * `FileSystemEntry` API. Files found inside a folder get a `webkitRelativePath` (like the folder picker gives them)
 * so they land in the right place in the folder view.
 */

/** Folders nested deeper than this are skipped (guards against symlink loops and absurd trees). */
const MAX_DEPTH = 40

const withRelativePath = (file: File, path: string): File => {
  try {
    Object.defineProperty(file, 'webkitRelativePath', { value: path, configurable: true })
  } catch {
    // frozen file objects keep their empty path: the track simply lands among the loose files
  }
  return file
}

const entryFile = (entry: FileSystemFileEntry): Promise<File | null> =>
  new Promise((resolve) => {
    try {
      entry.file(resolve, () => resolve(null))
    } catch {
      resolve(null)
    }
  })

/** Read every batch of a directory (a reader returns at most ~100 entries per call). */
async function readAll(dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = dir.createReader()
  const out: FileSystemEntry[] = []
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve) => {
      try {
        reader.readEntries(resolve, () => resolve([]))
      } catch {
        resolve([])
      }
    })
    if (!batch.length) return out
    out.push(...batch)
  }
}

/** Walk one dropped entry; `base` is the path of the folder that contains it. */
export async function walkEntry(entry: FileSystemEntry, base = '', depth = 0): Promise<File[]> {
  if (entry.isFile) {
    const file = await entryFile(entry as FileSystemFileEntry)
    return file ? [base ? withRelativePath(file, `${base}/${entry.name}`) : file] : []
  }
  if (!entry.isDirectory || depth >= MAX_DEPTH) return []
  const here = base ? `${base}/${entry.name}` : entry.name
  const children = await readAll(entry as FileSystemDirectoryEntry)
  children.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  const lists = await Promise.all(children.map((c) => walkEntry(c, here, depth + 1)))
  return lists.flat()
}

/**
 * Collect every file of a drop. Must be called synchronously inside the `drop` handler: the browser invalidates the
 * `DataTransfer` once the handler returns, so entries and plain files are captured before anything is awaited.
 */
export function filesFromDrop(dt: DataTransfer | null): Promise<File[]> {
  if (!dt) return Promise.resolve([])
  const captured: Array<{ entry: FileSystemEntry | null; file: File | null }> = []
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind !== 'file') continue
    const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null
    captured.push({ entry, file: item.getAsFile() })
  }
  if (!captured.length) return Promise.resolve(Array.from(dt.files ?? []))
  return Promise.all(captured.map(({ entry, file }) => (entry ? walkEntry(entry) : Promise.resolve(file ? [file] : [])))).then((lists) => lists.flat())
}
