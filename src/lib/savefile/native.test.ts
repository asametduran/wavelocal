import { describe, expect, it } from 'vitest'
import { CHUNK_BYTES } from './chunks'
import { SHARE_DIR, classify, createNativeSaver, messageOf } from './native'
import type { FilesPort, SharePort } from './native'

// The Android saver against a scripted device: an in-memory cache directory and a share sheet that answers as told.

const base64 = (data: Uint8Array): string => btoa(String.fromCharCode(...data))
const unbase64 = (text: string): Uint8Array => Uint8Array.from(atob(text), (c) => c.charCodeAt(0))
const bytesOf = (length: number, seed = 7): Uint8Array<ArrayBuffer> => Uint8Array.from({ length }, (_, i) => (i * seed + 13) % 256)
const concat = (parts: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}
/** What the fake encoded a slice as: tests do not need the browser's reader. */
const encode = async (slice: Blob): Promise<string> => base64(new Uint8Array(await slice.arrayBuffer()))
const blobOf = (data: Uint8Array<ArrayBuffer>): Blob => new Blob([data])
const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

interface Rig {
  save: (blob: Blob, name: string) => ReturnType<ReturnType<typeof createNativeSaver>>
  /** path -> the base64 slices written to it, in order */
  store: Map<string, string[]>
  log: string[]
  writes: { path: string; recursive: boolean; directory: string }[]
  appends: { path: string; directory: string }[]
  shared: Parameters<SharePort['share']>[0][]
}

function rig(
  options: {
    chunkBytes?: number
    existing?: readonly string[]
    readdirFails?: boolean
    deleteFails?: boolean
    failWrite?: (call: number) => unknown
    uri?: (path: string) => string
    share?: SharePort['share']
  } = {},
): Rig {
  const store = new Map<string, string[]>()
  for (const name of options.existing ?? []) store.set(`${SHARE_DIR}/${name}`, ['AAAA'])
  const log: string[] = []
  const writes: Rig['writes'] = []
  const appends: Rig['appends'] = []
  const shared: Rig['shared'] = []
  let calls = 0
  const files: FilesPort = {
    async readdir({ path }) {
      log.push(`readdir ${path}`)
      if (options.readdirFails) throw new Error('Directory does not exist')
      return { files: [...store.keys()].filter((key) => key.startsWith(`${path}/`)).map((key) => ({ name: key.slice(path.length + 1), type: 'file' })) }
    },
    async deleteFile({ path }) {
      log.push(`delete ${path}`)
      if (options.deleteFails) throw new Error('File does not exist')
      store.delete(path)
    },
    async writeFile({ path, data, recursive, directory }) {
      log.push(`write ${path}`)
      writes.push({ path, recursive, directory })
      const failure = options.failWrite?.(calls++)
      if (failure) throw failure
      store.set(path, [data])
      return { uri: options.uri ? options.uri(path) : `file:///cache/${path}` }
    },
    async appendFile({ path, data, directory }) {
      log.push(`append ${path}`)
      appends.push({ path, directory })
      const failure = options.failWrite?.(calls++)
      if (failure) throw failure
      store.get(path)?.push(data)
    },
  }
  const share: SharePort = {
    async share(request) {
      shared.push(request)
      return options.share ? options.share(request) : { activityType: 'com.example.drive' }
    },
  }
  return { save: createNativeSaver({ files, share, encode, chunkBytes: options.chunkBytes }), store, log, writes, appends, shared }
}

const stored = (r: Rig, name: string): Uint8Array => concat((r.store.get(`${SHARE_DIR}/${name}`) ?? []).map(unbase64))

describe('a file that is saved', () => {
  it('is written to the cache folder and its address is handed to the share sheet', async () => {
    const r = rig()
    const data = bytesOf(100)
    expect(await r.save(blobOf(data), 'My Playlist.m3u8')).toEqual({ kind: 'shared' })
    expect([...stored(r, 'My Playlist.m3u8')]).toEqual([...data])
    expect(r.shared).toEqual([{ title: 'My Playlist.m3u8', files: [`file:///cache/${SHARE_DIR}/My Playlist.m3u8`], dialogTitle: 'Save or send' }])
  })

  it('asks for the folder to be made by its first write, and keeps everything in the cache directory', async () => {
    const r = rig({ chunkBytes: 12 })
    await r.save(blobOf(bytesOf(40)), 'a.mp3')
    expect(r.writes).toEqual([{ path: `${SHARE_DIR}/a.mp3`, recursive: true, directory: 'CACHE' }])
    expect(r.appends.every((append) => append.directory === 'CACHE' && append.path === `${SHARE_DIR}/a.mp3`)).toBe(true)
  })

  it('is shared only after every slice has been written', async () => {
    const data = bytesOf(40)
    let onTheSheet: number[] | null = null
    let r!: Rig
    r = rig({
      chunkBytes: 12,
      share: async () => {
        onTheSheet = [...stored(r, 'a.mp3')] // what the file holds the moment the share sheet is asked for it
        return {}
      },
    })
    await r.save(blobOf(data), 'a.mp3')
    expect(onTheSheet).toEqual([...data])
  })

  it.each([0, 1, 2, 11, 12, 13, 24, 36, 37, 100, 1000])('is written whole whatever its length: %i bytes in slices of 12', async (size) => {
    const r = rig({ chunkBytes: 12 })
    const data = bytesOf(size)
    expect(await r.save(blobOf(data), 'f.bin')).toEqual({ kind: 'shared' })
    expect([...stored(r, 'f.bin')]).toEqual([...data])
    const slices = Math.max(1, Math.ceil(size / 12))
    expect(r.writes).toHaveLength(1) // the first slice is a write, even for a file with nothing in it
    expect(r.appends).toHaveLength(slices - 1) // and the others are appended
  })

  it('has padding only at the end of the last slice, since slices are a multiple of three', async () => {
    const r = rig({ chunkBytes: 12 })
    await r.save(blobOf(bytesOf(30)), 'f.bin')
    const slices = r.store.get(`${SHARE_DIR}/f.bin`) ?? []
    expect(slices).toHaveLength(3)
    expect(slices.slice(0, -1).some((slice) => slice.includes('='))).toBe(false)
  })

  it('is cut into slices of 768 KiB by default', async () => {
    const files: string[] = []
    const saver = createNativeSaver({
      files: {
        readdir: async () => ({ files: [] }),
        deleteFile: async () => undefined,
        writeFile: async ({ data }) => {
          files.push(`write:${data.length}`)
          return { uri: 'file:///cache/x' }
        },
        appendFile: async ({ data }) => void files.push(`append:${data.length}`),
      },
      share: { share: async () => ({}) },
      encode: async (slice) => 'x'.repeat(slice.size), // the length of a slice is what is under test, not its encoding
    })
    await saver(new Blob([new Uint8Array(CHUNK_BYTES * 2 + 5)]), 'big.bin')
    expect(files).toEqual([`write:${CHUNK_BYTES}`, `append:${CHUNK_BYTES}`, 'append:5'])
  })

  it('has a name that is safe, in the folder and on the share sheet', async () => {
    const r = rig()
    await r.save(blobOf(bytesOf(3)), '../a/b:c.m3u8')
    expect([...r.store.keys()]).toEqual([`${SHARE_DIR}/_a_b_c.m3u8`])
    expect(r.shared[0]?.title).toBe('_a_b_c.m3u8')
  })
})

describe('what an earlier save left in the folder', () => {
  it('is taken away before the next file is written, and only that folder is looked at', async () => {
    const r = rig({ existing: ['old.mp3', 'older.json'] })
    await r.save(blobOf(bytesOf(3)), 'new.m3u8')
    expect([...r.store.keys()]).toEqual([`${SHARE_DIR}/new.m3u8`])
    expect(r.log.slice(0, 3)).toEqual([`readdir ${SHARE_DIR}`, `delete ${SHARE_DIR}/old.mp3`, `delete ${SHARE_DIR}/older.json`])
  })

  it('is never taken away by the save that wrote it: the share sheet may still be reading it', async () => {
    const r = rig()
    await r.save(blobOf(bytesOf(3)), 'a.m3u8')
    expect(r.log.filter((line) => line.startsWith('delete'))).toEqual([])
    expect(r.store.has(`${SHARE_DIR}/a.m3u8`)).toBe(true)
  })

  it('leaves a subfolder alone', async () => {
    const files: string[] = []
    const saver = createNativeSaver({
      files: {
        readdir: async () => ({ files: [{ name: 'sub', type: 'directory' }, { name: 'a.txt', type: 'file' }, { name: 'b.txt' }] }),
        deleteFile: async ({ path }) => void files.push(path),
        writeFile: async () => ({ uri: 'file:///cache/x' }),
        appendFile: async () => undefined,
      },
      share: { share: async () => ({}) },
      encode,
    })
    await saver(blobOf(bytesOf(3)), 'n.txt')
    expect(files).toEqual([`${SHARE_DIR}/a.txt`, `${SHARE_DIR}/b.txt`])
  })

  it('waits for every removal to finish before it writes, even when one of them failed: a late removal must not take the new file', async () => {
    const store = new Set<string>([`${SHARE_DIR}/a.txt`, `${SHARE_DIR}/same.m3u8`])
    const order: string[] = []
    const saver = createNativeSaver({
      files: {
        readdir: async () => ({ files: [{ name: 'a.txt', type: 'file' }, { name: 'same.m3u8', type: 'file' }] }),
        deleteFile: async ({ path }) => {
          if (path.endsWith('a.txt')) throw new Error('File does not exist') // fails at once
          await new Promise((resolve) => setTimeout(resolve, 20)) // the old file of the same name takes a while
          store.delete(path)
          order.push(`deleted ${path}`)
        },
        writeFile: async ({ path }) => {
          store.add(path)
          order.push(`wrote ${path}`)
          return { uri: 'file:///cache/x' }
        },
        appendFile: async () => undefined,
      },
      share: { share: async () => ({}) },
      encode,
    })
    expect(await saver(blobOf(bytesOf(3)), 'same.m3u8')).toEqual({ kind: 'shared' })
    expect(order).toEqual([`deleted ${SHARE_DIR}/same.m3u8`, `wrote ${SHARE_DIR}/same.m3u8`])
    expect(store.has(`${SHARE_DIR}/same.m3u8`)).toBe(true)
  })

  it('does not stop a save when the folder cannot be read (it is not there yet) or a file cannot be removed', async () => {
    const first = rig({ readdirFails: true })
    expect(await first.save(blobOf(bytesOf(3)), 'a.mp3')).toEqual({ kind: 'shared' })
    const second = rig({ existing: ['old.mp3'], deleteFails: true })
    expect(await second.save(blobOf(bytesOf(3)), 'b.mp3')).toEqual({ kind: 'shared' })
  })
})

describe('a file that cannot be written', () => {
  it.each([
    ['no room', new Error('No space left on device'), 'full'],
    ['an errno', new Error('write failed: ENOSPC'), 'full'],
    ['a plain string', 'Not enough storage space', 'full'],
    ['a quota error', Object.assign(new Error('nope'), { name: 'QuotaExceededError' }), 'full'],
    ['a message in a plain object', { message: 'Disk full' }, 'full'],
    ['anything else', new Error('Permission denied'), 'other'],
    ['nothing at all', undefined, 'other'],
  ] as const)('says why: %s', async (_name, failure, why) => {
    const r = rig({ failWrite: () => failure ?? new Error('') })
    const outcome = await r.save(blobOf(bytesOf(10)), 'a.mp3')
    expect(outcome).toMatchObject({ kind: 'failed', why })
    expect(r.shared).toEqual([]) // nothing is shared that was not written
  })

  it('leaves no half file behind, whichever slice failed', async () => {
    for (const failAt of [0, 1, 2]) {
      const r = rig({ chunkBytes: 12, failWrite: (call) => (call === failAt ? new Error('No space left on device') : undefined) })
      const outcome = await r.save(blobOf(bytesOf(40)), 'a.mp3')
      expect(outcome).toMatchObject({ kind: 'failed', why: 'full' })
      expect(r.store.has(`${SHARE_DIR}/a.mp3`), `slice ${failAt}`).toBe(false)
      expect(r.shared).toEqual([])
    }
  })

  it('still answers when the half file cannot be removed either', async () => {
    const r = rig({ failWrite: () => new Error('No space left on device'), deleteFails: true })
    expect(await r.save(blobOf(bytesOf(10)), 'a.mp3')).toMatchObject({ kind: 'failed', why: 'full' })
  })

  it('hands back the error itself, for the error log', async () => {
    const failure = new Error('Something odd')
    const r = rig({ failWrite: () => failure })
    const outcome = await r.save(blobOf(bytesOf(10)), 'a.mp3')
    expect(outcome.kind === 'failed' && outcome.error).toBe(failure)
  })

  it.each(['content://media/1', 'https://example.test/x', '/data/user/0/x', '', undefined])('is not shared when the address is not a file address: %j', async (uri) => {
    const r = rig({ uri: () => uri as string })
    expect(await r.save(blobOf(bytesOf(3)), 'a.mp3')).toMatchObject({ kind: 'failed', why: 'other' })
    expect(r.shared).toEqual([])
  })

  it('fails, and does not throw, when the file cannot be read for encoding', async () => {
    const saver = createNativeSaver({
      files: { readdir: async () => ({ files: [] }), deleteFile: async () => undefined, writeFile: async () => ({ uri: 'file:///x' }), appendFile: async () => undefined },
      share: { share: async () => ({}) },
      encode: async () => {
        throw new DOMException('gone', 'NotReadableError')
      },
    })
    expect(await saver(blobOf(bytesOf(3)), 'a.mp3')).toMatchObject({ kind: 'failed', why: 'other' })
  })
})

describe('the share sheet', () => {
  it('closed without a choice is a cancel, not a failure, and the file stays for the next save to remove', async () => {
    const r = rig({
      share: async () => {
        throw new Error('Share canceled')
      },
    })
    expect(await r.save(blobOf(bytesOf(3)), 'a.mp3')).toEqual({ kind: 'cancelled' })
    expect(r.store.has(`${SHARE_DIR}/a.mp3`)).toBe(true)
  })

  it.each([
    ['an Error', new Error('Share canceled')],
    ['a string', 'Share canceled'],
    ['a plain object', { message: 'Share canceled' }],
    ['another spelling', new Error('The share was cancelled')],
  ])('is cancelled when the bridge says so as %s', async (_name, failure) => {
    const r = rig({
      share: async () => {
        throw failure
      },
    })
    expect(await r.save(blobOf(bytesOf(3)), 'a.mp3')).toEqual({ kind: 'cancelled' })
  })

  it('is busy while another share sheet of the app is open', async () => {
    const r = rig({
      share: async () => {
        throw new Error("Can't share while sharing is in progress")
      },
    })
    expect(await r.save(blobOf(bytesOf(3)), 'a.mp3')).toMatchObject({ kind: 'failed', why: 'busy' })
  })

  it('is another failure when it says anything else, with the error', async () => {
    const failure = new Error('only file urls are supported')
    const r = rig({
      share: async () => {
        throw failure
      },
    })
    const outcome = await r.save(blobOf(bytesOf(3)), 'a.mp3')
    expect(outcome).toMatchObject({ kind: 'failed', why: 'other' })
    expect(outcome.kind === 'failed' && outcome.error).toBe(failure)
  })
})

describe('a second save while the first is open', () => {
  it('is told "busy" at once, touches nothing, and does not disturb the first', async () => {
    const sheet = deferred<unknown>()
    const r = rig({ share: () => sheet.promise as Promise<unknown> })
    const first = r.save(blobOf(bytesOf(3)), 'first.m3u8')
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    const logBefore = [...r.log]
    expect(await r.save(blobOf(bytesOf(3)), 'second.m3u8')).toMatchObject({ kind: 'failed', why: 'busy' })
    expect(r.log).toEqual(logBefore) // not a read of the folder, not a write
    sheet.resolve({})
    expect(await first).toEqual({ kind: 'shared' })
    expect(r.store.has(`${SHARE_DIR}/first.m3u8`)).toBe(true)
  })

  it('can save again once the first is done, whether it was shared, cancelled or failed', async () => {
    let answer: 'ok' | 'cancel' | 'fail' = 'cancel'
    const r = rig({
      share: async () => {
        if (answer === 'cancel') throw new Error('Share canceled')
        if (answer === 'fail') throw new Error('boom')
        return {}
      },
    })
    expect(await r.save(blobOf(bytesOf(3)), 'a.mp3')).toEqual({ kind: 'cancelled' })
    answer = 'fail'
    expect(await r.save(blobOf(bytesOf(3)), 'b.mp3')).toMatchObject({ kind: 'failed', why: 'other' })
    answer = 'ok'
    expect(await r.save(blobOf(bytesOf(3)), 'c.mp3')).toEqual({ kind: 'shared' })
  })

  it('can save again after a write failed', async () => {
    let fail = true
    const r = rig({ failWrite: () => (fail ? new Error('No space left on device') : undefined) })
    expect(await r.save(blobOf(bytesOf(3)), 'a.mp3')).toMatchObject({ kind: 'failed', why: 'full' })
    fail = false
    expect(await r.save(blobOf(bytesOf(3)), 'a.mp3')).toEqual({ kind: 'shared' })
  })
})

describe('messageOf and classify', () => {
  it('read what a bridge error says, whatever shape it has', () => {
    expect(messageOf(new Error('x'))).toBe('x')
    expect(messageOf('y')).toBe('y')
    expect(messageOf({ message: 'z' })).toBe('z')
    expect(messageOf({ message: 5 })).toBe('')
    expect(messageOf(null)).toBe('')
    expect(messageOf(undefined)).toBe('')
    expect(messageOf(42)).toBe('')
  })

  it.each([
    ['No space left on device', 'full'],
    ['ENOSPC (No space left on device)', 'full'],
    ['There is not enough free space', 'full'],
    ['Not enough storage space', 'full'],
    ['The disk is full', 'full'],
    ['Storage is full', 'full'],
    ['Out of space', 'full'],
    ['Quota exceeded', 'full'],
    ["Can't share while sharing is in progress", 'busy'],
    ['Share canceled', 'other'],
    ['Permission denied', 'other'],
    ['', 'other'],
  ])('puts %j in the class %s', (message, why) => {
    expect(classify(new Error(message))).toBe(why)
  })

  it('knows a quota error by its name even with no words', () => {
    expect(classify(new DOMException('', 'QuotaExceededError'))).toBe('full')
  })
})
