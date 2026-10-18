// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The connection to the database is a module-level cache, so every test loads the module afresh, against a factory that can be told
// to do what a browser does: close the connection under the page, ask for it to be let go, or fail to open it.

interface FakeDb {
  name: string
  closed: boolean
  onclose: (() => void) | null
  onversionchange: (() => void) | null
  objectStoreNames: { contains(name: string): boolean }
  createObjectStore(name: string): void
  close(): void
  transaction(store: string, mode: string): { store: string; mode: string; of: FakeDb }
}

function fakeFactory(options: { failOpens?: number; bornClosedFrom?: number } = {}) {
  const dbs: FakeDb[] = []
  let failures = options.failOpens ?? 0
  const factory = {
    dbs,
    opens: 0,
    open(_name: string, _version: number) {
      factory.opens++
      const request: { result?: FakeDb; error?: unknown; onupgradeneeded?: () => void; onsuccess?: () => void; onerror?: () => void } = {}
      queueMicrotask(() => {
        if (failures-- > 0) {
          request.error = new DOMException('Internal error opening backing store', 'UnknownError')
          request.onerror?.()
          return
        }
        const db: FakeDb = {
          name: 'wavelocal',
          closed: dbs.length >= (options.bornClosedFrom ?? Number.POSITIVE_INFINITY),
          onclose: null,
          onversionchange: null,
          objectStoreNames: { contains: () => false },
          createObjectStore: () => {},
          close() {
            this.closed = true
          },
          transaction(store, mode) {
            if (this.closed) throw new DOMException('Failed to execute \'transaction\' on \'IDBDatabase\': The database connection is closing.', 'InvalidStateError')
            return { store, mode, of: this }
          },
        }
        dbs.push(db)
        request.result = db
        request.onupgradeneeded?.()
        request.onsuccess?.()
      })
      return request
    },
  }
  return factory
}

async function load(factory: ReturnType<typeof fakeFactory> | undefined) {
  vi.resetModules()
  if (factory) vi.stubGlobal('indexedDB', factory)
  else vi.stubGlobal('indexedDB', undefined)
  return import('./idb')
}

describe('the connection to the database', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('is opened once and shared', async () => {
    const factory = fakeFactory()
    const { open } = await load(factory)
    const [a, b] = await Promise.all([open(), open()])
    expect(a).toBe(b)
    expect(await open()).toBe(a)
    expect(factory.opens).toBe(1)
  })

  it('is opened again after the browser closes it (site data cleared, a storage error)', async () => {
    const factory = fakeFactory()
    const { open } = await load(factory)
    const first = (await open()) as unknown as FakeDb
    first.onclose?.()
    const second = await open()
    expect(second).not.toBe(first)
    expect(factory.opens).toBe(2)
  })

  it('is let go when another context wants to upgrade or delete the database, and opened again when it is next used', async () => {
    const factory = fakeFactory()
    const { open } = await load(factory)
    const first = (await open()) as unknown as FakeDb
    first.onversionchange?.()
    expect(first.closed).toBe(true)
    const second = (await open()) as unknown as FakeDb
    expect(second).not.toBe(first)
    expect(second.closed).toBe(false)
  })

  it('is not dropped by the late close of a connection that was already replaced', async () => {
    const factory = fakeFactory()
    const { open } = await load(factory)
    const old = (await open()) as unknown as FakeDb
    old.onclose?.()
    const current = await open()
    old.onclose?.() // the old one reports again
    expect(await open()).toBe(current)
    expect(factory.opens).toBe(2)
  })

  it('forgets a failed open, so the next use tries again', async () => {
    const factory = fakeFactory({ failOpens: 1 })
    const { open } = await load(factory)
    await expect(open()).rejects.toMatchObject({ name: 'UnknownError' })
    const db = await open()
    expect(db).toBeDefined()
    expect(factory.opens).toBe(2)
  })

  it('says so when this browser has no IndexedDB at all', async () => {
    const { open } = await load(undefined)
    await expect(open()).rejects.toThrow('IndexedDB unavailable')
  })
})

describe('transaction', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('starts a transaction on the shared connection', async () => {
    const factory = fakeFactory()
    const { transaction } = await load(factory)
    const t = (await transaction('meta', 'readwrite')) as unknown as { store: string; mode: string; of: FakeDb }
    expect(t).toMatchObject({ store: 'meta', mode: 'readwrite' })
    expect(t.of).toBe(factory.dbs[0])
  })

  it('opens a new connection and tries once more when the connection it holds was closed without a word', async () => {
    const factory = fakeFactory()
    const { transaction } = await load(factory)
    await transaction('meta', 'readonly')
    factory.dbs[0]?.close() // closed, and nothing told the page
    const t = (await transaction('meta', 'readwrite')) as unknown as { of: FakeDb }
    expect(t.of).toBe(factory.dbs[1])
    expect(factory.opens).toBe(2)
  })

  it('gives up after that one more try rather than looping, and says what the database said', async () => {
    const factory = fakeFactory({ bornClosedFrom: 1 }) // every connection after the first is already closing
    const { transaction } = await load(factory)
    await transaction('meta', 'readonly')
    factory.dbs[0]?.close()
    await expect(transaction('meta', 'readonly')).rejects.toMatchObject({ name: 'InvalidStateError' })
    expect(factory.opens).toBe(2)
  })

  it('does not hide any other error as a closed connection', async () => {
    const factory = fakeFactory()
    const { transaction } = await load(factory)
    await transaction('meta', 'readonly')
    const db = factory.dbs[0] as FakeDb
    db.transaction = () => {
      throw new DOMException('One of the specified object stores was not found.', 'NotFoundError')
    }
    await expect(transaction('nothing' as 'meta', 'readonly')).rejects.toMatchObject({ name: 'NotFoundError' })
    expect(factory.opens).toBe(1)
  })
})
