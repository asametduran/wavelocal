/**
 * How far the Media Session's back and forward buttons (the lock screen, a headset, the notification shade) move the playhead, in
 * seconds. A recording to listen to in parts makes them longer while it plays; the step the platform sends with the button, when
 * it sends one, wins. It is a module of its own because the player, which loads at start-up, reads it, while the code that
 * changes it loads later.
 */
export const DEFAULT_SKIP = 10

export const mediaSkip = { back: DEFAULT_SKIP, forward: DEFAULT_SKIP }
