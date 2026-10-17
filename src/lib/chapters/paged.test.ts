// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { PAGE, paged } from './paged'
import { seededRandom } from '../dsp'

/** A "file" of `size` bytes where byte i is i mod 251, and a log of the reads made on it. */
function file(size: number) {
  const log: [offset: number, length: number][] = []
  const read = async (offset: number, length: number): Promise<Uint8Array> => {
    log.push([offset, length])
    const out = new Uint8Array(Math.max(0, Math.min(length, size - offset)))
    for (let i = 0; i < out.length; i++) out[i] = (offset + i) % 251
    return out
  }
  return { read, log }
}

describe('paged', () => {
  it('answers many small requests inside one page with a single read', async () => {
    const f = file(100_000)
    const read = paged(f.read, 100_000)
    for (let i = 0; i < 100; i++) await read(i * 30, 20)
    expect(f.log).toHaveLength(1)
    expect(f.log[0]).toEqual([0, PAGE])
  })

  it('fetches a new page, starting where it is needed, for a request outside the one it has', async () => {
    const f = file(100_000)
    const read = paged(f.read, 100_000)
    await read(0, 10)
    const far = await read(50_000, 10)
    expect([...far]).toEqual(Array.from({ length: 10 }, (_, i) => (50_000 + i) % 251))
    expect(f.log).toEqual([[0, PAGE], [50_000, PAGE]])
  })

  it('makes a request that runs over the end of the page a new page of its own, with the right bytes', async () => {
    const f = file(100_000)
    const read = paged(f.read, 100_000)
    await read(0, 10)
    const across = await read(PAGE - 5, 20)
    expect([...across]).toEqual(Array.from({ length: 20 }, (_, i) => (PAGE - 5 + i) % 251))
    expect(f.log[1]).toEqual([PAGE - 5, PAGE])
  })

  it('passes a request for more than a page straight through and keeps the page it had', async () => {
    const f = file(100_000)
    const read = paged(f.read, 100_000)
    await read(0, 10)
    const big = await read(1000, PAGE * 3)
    expect(big).toHaveLength(PAGE * 3)
    await read(20, 10) // still in the first page
    expect(f.log).toEqual([[0, PAGE], [1000, PAGE * 3]])
  })

  it('never asks for bytes past the end it was given', async () => {
    const f = file(10_000)
    const read = paged(f.read, 10_000)
    await read(9_000, 100)
    expect(f.log).toEqual([[9_000, 1000]])
  })

  it('returns what there is when the file ends inside a request, and nothing past the end', async () => {
    const f = file(10_000)
    const read = paged(f.read, 10_000)
    expect(await read(9_990, 50)).toHaveLength(10)
    expect(await read(20_000, 50)).toHaveLength(0)
  })

  it('gives exactly the bytes of the file whatever the pattern of requests', async () => {
    const size = 60_000
    const f = file(size)
    const read = paged(f.read, size)
    const random = seededRandom(7)
    for (let i = 0; i < 400; i++) {
      const offset = Math.floor(random() * (size + 100))
      const length = 1 + Math.floor(random() * (random() < 0.1 ? 9000 : 200))
      const got = await read(offset, length)
      const want = Array.from({ length: Math.max(0, Math.min(length, size - offset)) }, (_, k) => (offset + k) % 251)
      expect([...got], `read(${offset}, ${length})`).toEqual(want)
    }
  })

  it('answers a request for nothing with nothing', async () => {
    const read = paged(file(1000).read, 1000)
    expect(await read(10, 0)).toHaveLength(0)
  })
})
