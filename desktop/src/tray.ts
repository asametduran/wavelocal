import { Menu, Tray, nativeImage } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { IDLE, buildTrayMenu, tooltipFor } from './tray-model'
import type { TrayActions } from './tray-model'
import { renderTrayIcon } from './tray-icon'
import type { NowPlaying } from './ipc'

export interface TrayHost extends TrayActions {
  isWindowVisible(): boolean
  getCloseToTray(): boolean
}

/** Owns the system tray icon: keeps its tooltip and context menu in step with the player and the window. */
export class TrayController {
  private readonly tray: Tray
  private state: NowPlaying = IDLE

  constructor(private readonly host: TrayHost) {
    const icon = nativeImage.createFromBitmap(renderTrayIcon(16), { width: 16, height: 16 })
    icon.addRepresentation({ scaleFactor: 2, width: 32, height: 32, buffer: renderTrayIcon(32) })
    this.tray = new Tray(icon)
    this.tray.on('click', () => host.toggleWindow())
    this.refresh()
  }

  setNowPlaying(state: NowPlaying): void {
    this.state = state
    this.refresh()
  }

  /** Rebuild the tooltip and menu from the current state (also called when the window is shown or hidden). */
  refresh(): void {
    if (this.tray.isDestroyed()) return
    this.tray.setToolTip(this.tooltip)
    this.tray.setContextMenu(Menu.buildFromTemplate(this.template()))
  }

  get tooltip(): string {
    return tooltipFor(this.state)
  }

  /** Labels of the menu entries, for tests. */
  get menuLabels(): string[] {
    return this.template().flatMap((item) => (item.type === 'separator' || !item.label ? [] : [item.label]))
  }

  /** Activate a menu entry by label, as a click would, for tests. */
  activate(label: string): boolean {
    const item = this.template().find((i) => i.label === label)
    if (!item || item.enabled === false || !item.click) return false
    ;(item.click as (...args: unknown[]) => void)({ checked: !this.host.getCloseToTray() }, undefined, {})
    return true
  }

  destroy(): void {
    if (!this.tray.isDestroyed()) this.tray.destroy()
  }

  private template(): MenuItemConstructorOptions[] {
    return buildTrayMenu({ state: this.state, windowVisible: this.host.isWindowVisible(), closeToTray: this.host.getCloseToTray() }, this.host)
  }
}
