/**
 * Streaming a track from one device to another over a WebRTC data channel.
 *
 * The sender reads the file in slices (never the whole file in memory), frames each slice as a numbered chunk, and
 * pauses whenever the channel's send buffer is full, so a 200 MB FLAC does not balloon the sender's memory or starve
 * the connection. The receiver accepts only a transfer it asked for, checks every chunk's order and size, and verifies
 * the byte count and a CRC-32 of the whole file before it hands the result on.
 */
import { CRC32_INIT, crc32Final, crc32Update } from './crc32'
import { CHUNK_HEADER, LIMITS, decodeChunk, encodeChunk, encodeFileFrame } from './protocol'
import type { FileFrame, TrackMeta } from './protocol'

/** The part of an RTCDataChannel the sender needs (a fake in tests, the real thing in the browser). */
export interface SendChannel {
  readyState: string
  bufferedAmount: number
  bufferedAmountLowThreshold: number
  send(data: string | ArrayBuffer): void
  addEventListener(type: 'bufferedamountlow' | 'close', listener: () => void): void
  removeEventListener(type: 'bufferedamountlow' | 'close', listener: () => void): void
}

export const CHUNK_BYTES = 16 * 1024
/** Stop queueing when this much is waiting to be sent, resume when it drains to `LOW_WATER`. */
export const HIGH_WATER = 1024 * 1024
export const LOW_WATER = 256 * 1024
const READ_BYTES = 256 * 1024

export interface SendOptions {
  signal?: AbortSignal
  onProgress?: (sent: number, total: number) => void
  chunkBytes?: number
}

export class TransferAborted extends Error {
  constructor(reason = 'The transfer was cancelled.') {
    super(reason)
    this.name = 'TransferAborted'
  }
}

/** Resolve once the channel's buffer has drained below the low-water mark, or throw if it closes or is aborted first. */
function drained(channel: SendChannel, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = (error?: Error) => {
      channel.removeEventListener('bufferedamountlow', onLow)
      channel.removeEventListener('close', onClose)
      signal?.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve()
    }
    const onLow = () => done()
    const onClose = () => done(new TransferAborted('The connection closed.'))
    const onAbort = () => done(new TransferAborted())
    channel.bufferedAmountLowThreshold = LOW_WATER
    channel.addEventListener('bufferedamountlow', onLow)
    channel.addEventListener('close', onClose)
    signal?.addEventListener('abort', onAbort)
    if (signal?.aborted) onAbort()
    else if (channel.readyState !== 'open') onClose()
    else if (channel.bufferedAmount <= LOW_WATER) onLow()
  })
}

/** Send `file` as transfer `id`. Resolves when the last byte has been queued; rejects with `TransferAborted` if cut short. */
export async function sendFile(channel: SendChannel, id: number, file: Blob, meta: TrackMeta, options: SendOptions = {}): Promise<void> {
  const { signal, onProgress, chunkBytes = CHUNK_BYTES } = options
  if (chunkBytes <= 0 || chunkBytes > LIMITS.chunkBytes) throw new RangeError('Chunk size out of range.')
  if (file.size !== meta.size) throw new Error('The file changed since it was announced.')
  const alive = () => {
    if (signal?.aborted) throw new TransferAborted()
    if (channel.readyState !== 'open') throw new TransferAborted('The connection closed.')
  }
  alive()
  channel.send(encodeFileFrame({ t: 'begin', id, meta }))
  let crc = CRC32_INIT
  let index = 0
  let sent = 0
  for (let at = 0; at < file.size; at += READ_BYTES) {
    const block = new Uint8Array(await file.slice(at, Math.min(file.size, at + READ_BYTES)).arrayBuffer())
    for (let o = 0; o < block.length; o += chunkBytes) {
      if (channel.bufferedAmount > HIGH_WATER) await drained(channel, signal)
      alive()
      const bytes = block.subarray(o, Math.min(block.length, o + chunkBytes))
      crc = crc32Update(crc, bytes)
      channel.send(encodeChunk(id, index++, bytes))
      sent += bytes.length
    }
    onProgress?.(sent, file.size)
  }
  alive()
  channel.send(encodeFileFrame({ t: 'end', id, crc: crc32Final(crc), bytes: sent }))
}

export type ReceiveFailure = { key: string | null; reason: string }

export interface ReceiverEvents {
  /** Is this track one we asked for? Anything else is refused before a single byte is stored. */
  wanted(key: string): boolean
  onProgress?(meta: TrackMeta, received: number): void
  onFile(meta: TrackMeta, blob: Blob): void
  onFail(failure: ReceiveFailure): void
}

interface Active {
  id: number
  meta: TrackMeta
  parts: ArrayBuffer[]
  received: number
  nextIndex: number
  crc: number
}

/** Receives one transfer at a time from the `file` channel and refuses anything unrequested, malformed or corrupt. */
export class FileReceiver {
  private active: Active | null = null
  /** Id of a transfer we declined; its chunks are dropped silently instead of being treated as errors. */
  private declined = new Set<number>()

  constructor(private readonly events: ReceiverEvents) {}

  /** The track currently arriving, for progress displays. */
  get current(): { meta: TrackMeta; received: number } | null {
    return this.active ? { meta: this.active.meta, received: this.active.received } : null
  }

  handleFrame(frame: FileFrame): void {
    if (frame.t === 'begin') return this.begin(frame.id, frame.meta)
    if (frame.t === 'abort') {
      if (this.active?.id === frame.id) this.fail(frame.reason || 'The other device stopped sending.')
      this.declined.delete(frame.id)
      return
    }
    if (this.declined.delete(frame.id)) return
    const a = this.active
    if (!a || a.id !== frame.id) return this.events.onFail({ key: null, reason: 'Unexpected data from the other device.' })
    if (frame.bytes !== a.received || a.received !== a.meta.size) return this.fail('The file arrived incomplete.')
    if (crc32Final(a.crc) !== frame.crc) return this.fail('The file arrived damaged.')
    this.active = null
    this.events.onFile(a.meta, new Blob(a.parts, { type: a.meta.type }))
  }

  /** Feed one binary frame from the channel. */
  handleBinary(buffer: ArrayBuffer): void {
    const chunk = decodeChunk(buffer)
    if (!chunk) return this.fail('Received a malformed data frame.')
    const a = this.active
    if (!a || a.id !== chunk.id) {
      if (this.declined.has(chunk.id)) return
      return this.events.onFail({ key: null, reason: 'Unexpected data from the other device.' })
    }
    if (chunk.index !== a.nextIndex) return this.fail('Data arrived out of order.')
    if (a.received + chunk.bytes.length > a.meta.size) return this.fail('The other device sent more than it announced.')
    a.parts.push(buffer.slice(CHUNK_HEADER))
    a.received += chunk.bytes.length
    a.nextIndex++
    a.crc = crc32Update(a.crc, chunk.bytes)
    this.events.onProgress?.(a.meta, a.received)
  }

  /** Drop the transfer in progress (the user left, the connection died). */
  cancel(): void {
    this.active = null
    this.declined.clear()
  }

  private begin(id: number, meta: TrackMeta): void {
    if (this.active) this.fail('A new transfer started before the last one finished.')
    if (!this.events.wanted(meta.key)) {
      if (this.declined.size > 64) this.declined.clear()
      this.declined.add(id)
      return
    }
    this.active = { id, meta, parts: [], received: 0, nextIndex: 0, crc: CRC32_INIT }
    this.events.onProgress?.(meta, 0)
  }

  private fail(reason: string): void {
    const key = this.active?.meta.key ?? null
    // the rest of a failed transfer is still on its way: drop it quietly instead of reporting every frame
    if (this.active) this.declined.add(this.active.id)
    this.active = null
    this.events.onFail({ key, reason })
  }
}
