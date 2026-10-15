import { useEffect, useMemo, useRef } from 'react'
import { getDesktopBridge } from '../desktop-bridge'
import type { TrayCommand } from '../desktop-bridge'
import type { PlayerApi } from '../types'

type TrayPlayer = Pick<PlayerApi, 'current' | 'playing' | 'toggle' | 'next' | 'prev'>

/** Apply a command chosen in the tray to the player. */
export function runTrayCommand(player: Pick<TrayPlayer, 'toggle' | 'next' | 'prev'>, command: TrayCommand): void {
  if (command === 'toggle') player.toggle()
  else if (command === 'next') player.next()
  else player.prev()
}

/**
 * Connects the player to the desktop shell's system tray: reports what is playing and obeys the tray's play/pause,
 * next and previous. Does nothing in a browser or on Android, where there is no desktop bridge.
 */
export function useDesktopTray(player: TrayPlayer): void {
  const tray = useMemo(() => getDesktopBridge()?.tray, [])
  const latest = useRef(player)
  latest.current = player

  const title = player.current?.title
  const artist = player.current?.artist
  const playing = player.playing

  useEffect(() => {
    tray?.setNowPlaying(title === undefined ? null : { title, artist: artist ?? '', playing })
  }, [tray, title, artist, playing])

  useEffect(() => tray?.onCommand((command) => runTrayCommand(latest.current, command)), [tray])
}
