import { createChoicePref, deviceStorage, followOtherWindows } from '../choicepref'
import type { StorageLike } from '../choicepref'

/**
 * When the row of loop and bookmark buttons shows under the seek bar: "auto" (for a recording that has chapters, a loop, bookmarks
 * or is long, so a song looks as it always did) or "always" (for every track; the way to reach the buttons on a phone, which has
 * no L and B keys, for a song).
 */

export type ToolsRow = 'auto' | 'always'
export const TOOLS_ROW_KEY = 'wl.seektools'

export const parseToolsRow = (raw: unknown): ToolsRow => (raw === 'always' ? 'always' : 'auto')

export const createToolsRowPref = (storage: () => StorageLike | null) => createChoicePref(TOOLS_ROW_KEY, parseToolsRow, storage)

export const toolsRow = createToolsRowPref(deviceStorage)

followOtherWindows(TOOLS_ROW_KEY, toolsRow.refresh)
