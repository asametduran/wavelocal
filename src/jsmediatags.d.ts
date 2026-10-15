/** Minimal typings for the bundled jsmediatags build (only the fields Wavelocal reads). */
declare module 'jsmediatags/dist/jsmediatags.min.js' {
  export interface Picture {
    format?: string
    data?: ArrayLike<number>
  }

  /** An ID3v2 TXXX payload. */
  export interface TxxxPayload {
    user_description?: string
    data?: string
  }
  /** A TXXX frame: some builds wrap the payload in `data`, others expose it directly. */
  export type TxxxFrame = TxxxPayload | { data: TxxxPayload }

  export interface Tags {
    title?: string
    artist?: string
    album?: string
    lyrics?: string | { lyrics?: string }
    picture?: Picture
    TXXX?: TxxxFrame | TxxxFrame[]
  }

  interface ReadCallbacks {
    onSuccess: (result: { tags?: Tags }) => void
    onError: (error: unknown) => void
  }

  const jsmediatags: { read(file: Blob | string, callbacks: ReadCallbacks): void }
  export default jsmediatags
}
