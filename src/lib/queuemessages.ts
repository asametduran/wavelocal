import { countLabel } from './format'

/** What a toast says after tracks were queued by hand or the queue was emptied. */

const NAME_LIMIT = 60
const short = (name: string): string => (name.length > NAME_LIMIT ? `${name.slice(0, NAME_LIMIT - 1).trimEnd()}…` : name)

/** "Playing next: Help!", "12 tracks will play next", "Added to the queue: Help!", "Added 12 tracks to the queue". */
export function queuedMessage(kind: 'next' | 'last', count: number, first: string): string {
  if (count <= 0) return ''
  if (kind === 'next') return count === 1 ? `Playing next: ${short(first)}` : `${count} tracks will play next`
  return count === 1 ? `Added to the queue: ${short(first)}` : `Added ${count} tracks to the queue`
}

export const clearedMessage = (count: number): string => (count > 0 ? `Cleared ${countLabel(count, 'queued track')}` : '')
