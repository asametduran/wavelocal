/**
 * A multiple of three, so that no slice but the last carries base64 padding: written one after the other, the slices of a file are
 * one valid stream. 768 KiB is 1 MiB of base64, small enough for the bridge between the page and the native side.
 */
export const CHUNK_BYTES = 768 * 1024

/** The base64 text of `blob`, read by the browser rather than through the JavaScript heap, without the `data:` prefix. */
export function base64Of(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('The file could not be read'))
    reader.onload = () => {
      const url = String(reader.result)
      resolve(url.slice(url.indexOf(',') + 1))
    }
    reader.readAsDataURL(blob)
  })
}
