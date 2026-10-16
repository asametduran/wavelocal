import { describe, expect, it, vi } from 'vitest'
import { crc32 } from './crc32'
import { encodeChunk, encodeFileFrame, parseFileFrame } from './protocol'
import type { FileFrame, TrackMeta } from './protocol'
import { FileReceiver, HIGH_WATER, TransferAborted, sendFile } from './transfer'
import type { ReceiverEvents, SendChannel } from './transfer'

const baseMeta = (over: Partial<TrackMeta> = {}): TrackMeta => ({
  key: 'song.wav|1000|1700000000000',
  name: 'song.wav',
  size: 1000,
  lastModified: 1700000000000,
  type: 'audio/wav',
  title: 'Song',
  artist: 'Artist',
  album: 'Album',
  duration: 12.5,
  ...over,
})

/** A data channel that records what is sent, with a controllable send buffer. */
class FakeChannel implements SendChannel {
  readyState = 'open'
  bufferedAmount = 0
  bufferedAmountLowThreshold = 0
  sent: (string | ArrayBuffer)[] = []
  private listeners = new Map<string, Set<() => void>>()
  /** Pretend the network drains this many bytes each time somebody waits for it. */
  drainPerWait = Infinity
  waits = 0
  maxBuffered = 0

  send(data: string | ArrayBuffer): void {
    this.sent.push(data)
    this.bufferedAmount += typeof data === 'string' ? data.length : data.byteLength
    this.maxBuffered = Math.max(this.maxBuffered, this.bufferedAmount)
  }
  addEventListener(type: string, fn: () => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)?.add(fn)
    if (type === 'bufferedamountlow' && this.drainPerWait > 0) {
      this.waits++
      queueMicrotask(() => {
        this.bufferedAmount = Math.max(0, this.bufferedAmount - this.drainPerWait)
        this.emit('bufferedamountlow')
      })
    }
  }
  removeEventListener(type: string, fn: () => void): void {
    this.listeners.get(type)?.delete(fn)
  }
  emit(type: string): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn()
  }
  close(): void {
    this.readyState = 'closed'
    this.emit('close')
  }
}

const bytesOf = (n: number, seed = 1) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 0xff)
const fileOf = (data: Uint8Array) => new Blob([data as BlobPart], { type: 'audio/wav' })
const metaFor = (data: Uint8Array, over: Partial<TrackMeta> = {}): TrackMeta => baseMeta({ size: data.length, ...over })

/** Pipe everything the channel sent into a receiver, as the data channels would deliver it. */
function deliver(channel: FakeChannel, receiver: FileReceiver, skip: (i: number) => boolean = () => false): void {
  channel.sent.forEach((frame, i) => {
    if (skip(i)) return
    if (typeof frame === 'string') {
      const parsed = parseFileFrame(frame)
      if (parsed) receiver.handleFrame(parsed)
    } else receiver.handleBinary(frame)
  })
}

function receiverWith(over: Partial<ReceiverEvents> = {}) {
  const files: { meta: TrackMeta; blob: Blob }[] = []
  const failures: { key: string | null; reason: string }[] = []
  const progress: number[] = []
  const receiver = new FileReceiver({
    wanted: () => true,
    onProgress: (_m, n) => progress.push(n),
    onFile: (m, blob) => files.push({ meta: m, blob }),
    onFail: (f) => failures.push(f),
    ...over,
  })
  return { receiver, files, failures, progress }
}

describe('sendFile + FileReceiver', () => {
  it('delivers a file byte for byte', async () => {
    const data = bytesOf(100_000)
    const channel = new FakeChannel()
    await sendFile(channel, 7, fileOf(data), metaFor(data))
    const { receiver, files, failures } = receiverWith()
    deliver(channel, receiver)
    expect(failures).toEqual([])
    expect(files).toHaveLength(1)
    expect(new Uint8Array(await files[0]!.blob.arrayBuffer())).toEqual(data)
    expect(files[0]?.blob.type).toBe('audio/wav')
  })

  it('handles files that are not a multiple of the chunk size, and tiny ones', async () => {
    for (const size of [1, 2, 16 * 1024 - 1, 16 * 1024, 16 * 1024 + 1, 256 * 1024 + 5]) {
      const data = bytesOf(size, size)
      const channel = new FakeChannel()
      await sendFile(channel, 1, fileOf(data), metaFor(data))
      const { receiver, files, failures } = receiverWith()
      deliver(channel, receiver)
      expect(failures).toEqual([])
      expect(new Uint8Array(await files[0]!.blob.arrayBuffer())).toEqual(data)
    }
  })

  it('announces first, ends with the byte count and checksum', async () => {
    const data = bytesOf(40_000)
    const channel = new FakeChannel()
    await sendFile(channel, 3, fileOf(data), metaFor(data), { chunkBytes: 8192 })
    const frames = channel.sent.filter((f): f is string => typeof f === 'string').map((f) => parseFileFrame(f) as FileFrame)
    expect(frames[0]).toMatchObject({ t: 'begin', id: 3 })
    expect(frames[1]).toEqual({ t: 'end', id: 3, crc: crc32(data), bytes: 40_000 })
    expect(channel.sent.filter((f) => typeof f !== 'string')).toHaveLength(5)
    expect(typeof channel.sent[0]).toBe('string')
    expect(typeof channel.sent.at(-1)).toBe('string')
  })

  it('reports progress as it goes', async () => {
    const data = bytesOf(700_000)
    const onProgress = vi.fn()
    await sendFile(new FakeChannel(), 1, fileOf(data), metaFor(data), { onProgress })
    expect(onProgress).toHaveBeenCalled()
    expect(onProgress.mock.calls.at(-1)).toEqual([700_000, 700_000])
  })

  it('waits for the send buffer to drain instead of queueing the whole file', async () => {
    const data = bytesOf(HIGH_WATER * 6)
    const channel = new FakeChannel()
    channel.drainPerWait = HIGH_WATER
    await sendFile(channel, 1, fileOf(data), metaFor(data))
    expect(channel.waits).toBeGreaterThan(2)
    expect(channel.maxBuffered).toBeLessThan(HIGH_WATER * 2)
  })

  it('stops when aborted', async () => {
    const data = bytesOf(HIGH_WATER * 4)
    const channel = new FakeChannel()
    channel.drainPerWait = 0
    const controller = new AbortController()
    const promise = sendFile(channel, 1, fileOf(data), metaFor(data), { signal: controller.signal })
    setTimeout(() => controller.abort(), 5)
    await expect(promise).rejects.toBeInstanceOf(TransferAborted)
    expect(channel.sent.length).toBeLessThan(200)
  })

  it('stops when the connection closes mid-transfer', async () => {
    const data = bytesOf(HIGH_WATER * 3)
    const channel = new FakeChannel()
    channel.drainPerWait = 0
    const promise = sendFile(channel, 1, fileOf(data), metaFor(data))
    setTimeout(() => channel.close(), 5)
    await expect(promise).rejects.toThrow(/closed/)
  })

  it('refuses to start on a closed channel or with a size that no longer matches', async () => {
    const data = bytesOf(10)
    const closed = new FakeChannel()
    closed.readyState = 'closed'
    await expect(sendFile(closed, 1, fileOf(data), metaFor(data))).rejects.toBeInstanceOf(TransferAborted)
    await expect(sendFile(new FakeChannel(), 1, fileOf(data), metaFor(data, { size: 11 }))).rejects.toThrow(/changed/)
    await expect(sendFile(new FakeChannel(), 1, fileOf(data), metaFor(data), { chunkBytes: 0 })).rejects.toBeInstanceOf(RangeError)
  })
})

describe('FileReceiver safety', () => {
  const data = bytesOf(50_000)
  const sendAll = async (id = 1) => {
    const channel = new FakeChannel()
    await sendFile(channel, id, fileOf(data), metaFor(data))
    return channel
  }

  it('refuses transfers it did not ask for, without reporting an error', async () => {
    const { receiver, files, failures } = receiverWith({ wanted: () => false })
    deliver(await sendAll(), receiver)
    expect(files).toEqual([])
    expect(failures).toEqual([])
  })

  it('detects a lost chunk', async () => {
    const { receiver, files, failures } = receiverWith()
    deliver(await sendAll(), receiver, (i) => i === 2)
    expect(files).toEqual([])
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatchObject({ key: baseMeta().key, reason: expect.stringMatching(/order/) })
  })

  it('detects a truncated file', async () => {
    const channel = await sendAll()
    const { receiver, files, failures } = receiverWith()
    deliver(channel, receiver, (i) => i === channel.sent.length - 2)
    expect(files).toEqual([])
    expect(failures[0]?.reason).toMatch(/incomplete/)
  })

  it('detects corruption that keeps the length', async () => {
    const channel = await sendAll()
    const chunk = channel.sent[2] as ArrayBuffer
    new Uint8Array(chunk)[20] = ((new Uint8Array(chunk)[20] as number) ^ 0xff) & 0xff
    const { receiver, files, failures } = receiverWith()
    deliver(channel, receiver)
    expect(files).toEqual([])
    expect(failures[0]?.reason).toMatch(/damaged/)
  })

  it('refuses more data than announced', () => {
    const { receiver, failures } = receiverWith()
    receiver.handleFrame({ t: 'begin', id: 1, meta: baseMeta({ size: 10 }) })
    receiver.handleBinary(encodeChunk(1, 0, bytesOf(11)))
    expect(failures[0]?.reason).toMatch(/more than/)
  })

  it('refuses chunks for an unknown transfer and malformed frames', () => {
    const { receiver, failures } = receiverWith()
    receiver.handleBinary(encodeChunk(9, 0, bytesOf(4)))
    receiver.handleBinary(new ArrayBuffer(3))
    expect(failures).toHaveLength(2)
  })

  it('does not pile up errors for the rest of a failed transfer', async () => {
    const channel = await sendAll()
    const { receiver, failures } = receiverWith()
    deliver(channel, receiver, (i) => i === 1)
    expect(failures).toHaveLength(1)
  })

  it('reports when the sender gives up, and can take the next transfer afterwards', async () => {
    const { receiver, files, failures } = receiverWith()
    receiver.handleFrame({ t: 'begin', id: 1, meta: baseMeta() })
    receiver.handleFrame({ t: 'abort', id: 1, key: baseMeta().key, reason: 'file removed' })
    expect(failures[0]).toMatchObject({ reason: 'file removed' })
    deliver(await sendAll(2), receiver)
    expect(files).toHaveLength(1)
  })

  it('fails the old transfer when a new one starts too early', () => {
    const { receiver, failures } = receiverWith()
    receiver.handleFrame({ t: 'begin', id: 1, meta: baseMeta() })
    receiver.handleFrame({ t: 'begin', id: 2, meta: baseMeta() })
    expect(failures[0]?.reason).toMatch(/new transfer/)
    expect(receiver.current).toMatchObject({ received: 0 })
  })

  it('exposes progress and forgets everything on cancel', () => {
    const { receiver, progress } = receiverWith()
    receiver.handleFrame({ t: 'begin', id: 1, meta: baseMeta({ size: 100 }) })
    receiver.handleBinary(encodeChunk(1, 0, bytesOf(40)))
    expect(receiver.current).toMatchObject({ received: 40 })
    expect(progress).toEqual([0, 40])
    receiver.cancel()
    expect(receiver.current).toBeNull()
  })

  it('encodes the begin frame it expects', () => {
    expect(parseFileFrame(encodeFileFrame({ t: 'begin', id: 1, meta: baseMeta() }))).toMatchObject({ t: 'begin' })
  })
})
