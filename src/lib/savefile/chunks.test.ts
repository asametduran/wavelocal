import { afterEach, describe, expect, it, vi } from 'vitest'
import { CHUNK_BYTES, base64Of } from './chunks'

const base64 = (data: Uint8Array): string => btoa(String.fromCharCode(...data))
const bytesOf = (length: number, seed = 7): Uint8Array<ArrayBuffer> => Uint8Array.from({ length }, (_, i) => (i * seed + 13) % 256)

afterEach(() => vi.unstubAllGlobals())

describe('CHUNK_BYTES', () => {
  it('is a multiple of three, so that only the last slice of a file carries base64 padding', () => {
    expect(CHUNK_BYTES % 3).toBe(0)
  })

  it('is small enough for the bridge: a megabyte of base64 or so', () => {
    expect((CHUNK_BYTES / 3) * 4).toBeLessThanOrEqual(1024 * 1024)
  })
})

describe('base64Of', () => {
  it('encodes bytes the way btoa does', async () => {
    const data = bytesOf(1000)
    expect(await base64Of(new Blob([data]))).toBe(base64(data))
  })

  it('is empty for an empty blob', async () => {
    expect(await base64Of(new Blob([]))).toBe('')
  })

  it('has no data: prefix, whatever the type of the blob', async () => {
    expect(await base64Of(new Blob(['x'], { type: 'audio/mpeg' }))).toBe('eA==')
    expect(await base64Of(new Blob(['x']))).toBe('eA==')
  })

  it('carries padding only on a slice that does not end on a multiple of three', async () => {
    expect(await base64Of(new Blob([bytesOf(3)]))).not.toContain('=')
    expect(await base64Of(new Blob([bytesOf(4)]))).toContain('=')
  })

  it('writes slices of a multiple of three, joined, as the whole file', async () => {
    const data = bytesOf(10_000)
    const blob = new Blob([data])
    const step = 3000
    const parts: string[] = []
    for (let offset = 0; offset < blob.size; offset += step) parts.push(await base64Of(blob.slice(offset, offset + step)))
    expect(parts.join('')).toBe(base64(data))
  })

  it('rejects when the browser cannot read the blob', async () => {
    class FailingReader {
      onerror: (() => void) | null = null
      onload: (() => void) | null = null
      error = new DOMException('gone', 'NotReadableError')
      readAsDataURL(): void {
        queueMicrotask(() => this.onerror?.())
      }
    }
    vi.stubGlobal('FileReader', FailingReader)
    await expect(base64Of(new Blob(['x']))).rejects.toMatchObject({ name: 'NotReadableError' })
  })
})
