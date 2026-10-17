import { createChoicePref, deviceStorage, followOtherWindows } from '../choicepref'
import type { StorageLike } from '../choicepref'

/**
 * The seek bar style, "waveform" or "plain", kept on this device. It is a small store (not component state) because the seek
 * bar is mounted twice and the settings panel changes it: all of them must follow one switch. The start-up code reads the same
 * key directly (`PlayerBar.tsx`) only to reserve the space before this module has loaded.
 */

export type { StorageLike }
export type SeekStyle = 'waveform' | 'plain'
export const SEEK_STYLE_KEY = 'wl.seekbar'

/** The waveform unless the person chose the plain bar: an unknown or damaged value must never hide it. */
export const parseSeekStyle = (raw: unknown): SeekStyle => (raw === 'plain' ? 'plain' : 'waveform')

export const createSeekStylePref = (storage: () => StorageLike | null) => createChoicePref(SEEK_STYLE_KEY, parseSeekStyle, storage)

export const seekStyle = createSeekStylePref(deviceStorage)

// a change made in another window of the app
followOtherWindows(SEEK_STYLE_KEY, seekStyle.refresh)
