/**
 * Reading a file in small pages for the chapter readers, which walk many small structures (frames, boxes) and hop over big
 * ones (pictures): a walk of small frames costs a read per few kilobytes, a hop costs the one page where the walk resumes.
 * A request for more than a page is passed through without disturbing the page.
 */

export type Reader = (offset: number, length: number) => Promise<Uint8Array>

export const PAGE = 4096

/** `read` with a one-page cache; nothing at or past `end` is asked for. */
export function paged(read: Reader, end: number, page: number = PAGE): Reader {
  let start = 0
  let held: Uint8Array = new Uint8Array(0)
  return async (offset, length) => {
    if (length <= 0) return new Uint8Array(0)
    if (offset >= start && offset + length <= start + held.length) return held.subarray(offset - start, offset - start + length)
    if (length > page) return read(offset, length)
    held = await read(offset, Math.max(length, Math.min(page, end - offset)))
    start = offset
    return held.subarray(0, Math.min(length, held.length))
  }
}
