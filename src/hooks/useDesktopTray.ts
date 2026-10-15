import { useEffect, useMemo, useRef } from 'react'
import { getDesktopBridge } from '../desktop-bridge'
import type { DesktopCommand } from '../desktop-bridge'
import type { PlayerApi } from '../types'

type TrayPlayer = Pick<PlayerApi, 'current' | 'playing' | 'toggle' | 'next' | 'prev' | 'volumeBy' | 'toggleMute'>

/** How much one volume hotkey press changes the volume (0..1). */
export const VOLUME_STEP = 0.05

/** Apply a command from the tray menu or a global hotkey to the player. */
export function runDesktopCommand(player: Omit<TrayPlayer, 'current' | 'playing'>, command: DesktopCommand): void {
  switch (command) {
    case 'toggle':
      return player.toggle()
    case 'next':
      return player.next()
    case 'prev':
      return player.prev()
    case 'volumeUp':
      return player.volumeBy(VOLUME_STEP)
    case 'volumeDown':
      return player.volumeBy(-VOLUME_STEP)
    case 'mute':
      return player.toggleMute()
  }
}

/**
 * Connects the player to the desktop shell: reports what is playing to the tray and obeys the tray menu and the global
 * hotkeys. Does nothing in a browser or on Android, where there is no desktop bridge.
 */
export function useDesktopTray(player: TrayPlayer): void {
  const { tray, commands } = useMemo(() => {
    const bridge = getDesktopBridge()
    return { tray: bridge?.tray, commands: bridge?.commands }
  }, [])
  const latest = useRef(player)
  latest.current = player

  const title = player.current?.title
  const artist = player.current?.artist
  const playing = player.playing

  useEffect(() => {
    tray?.setNowPlaying(title === undefined ? null : { title, artist: artist ?? '', playing })
  }, [tray, title, artist, playing])

  useEffect(() => commands?.onCommand((command) => runDesktopCommand(latest.current, command)), [commands])
}
