import { app, BrowserWindow, Menu, protocol, screen, session } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import * as path from 'node:path'
import { APP_SCHEME, APP_URL, buildCsp, isAllowedNavigation, isAllowedRequest, mimeFor, resolveAppPath, securityHeaders } from './security'
import { DEFAULT_WINDOW, MIN_WINDOW, fitToDisplays, parseWindowState, snapshotWindowState } from './window-state'
import type { WindowState } from './window-state'

/**
 * Wavelocal desktop shell. It only hosts the built web app: all audio, library and settings logic lives in the web
 * app, and the shell adds a locked-down window, native integration points (later milestones) and nothing else.
 *
 * Security stance: the page runs sandboxed with context isolation and no Node access, from a private `app://` origin;
 * every request except the app's own files and in-memory blobs is cancelled (the player never touches the network),
 * a strict Content-Security-Policy is attached, navigation and new windows are denied, and every permission request
 * is refused.
 */

// ---- configuration (development overrides are ignored in a packaged build) ----

const devUrl = app.isPackaged ? undefined : process.env.WAVELOCAL_DEV_URL
const devOrigin = devUrl ? new URL(devUrl).origin : undefined
const webRoot =
  (!app.isPackaged && process.env.WAVELOCAL_WEB_ROOT) || (app.isPackaged ? path.join(process.resourcesPath, 'web') : path.join(app.getAppPath(), '..', 'dist'))

if (!app.isPackaged && process.env.WAVELOCAL_USER_DATA) app.setPath('userData', process.env.WAVELOCAL_USER_DATA)

// must run before the app is ready
protocol.registerSchemesAsPrivileged([{ scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }])

// ---- window state ----

const stateFile = () => path.join(app.getPath('userData'), 'window-state.json')

function loadWindowState(): WindowState | null {
  try {
    return parseWindowState(JSON.parse(readFileSync(stateFile(), 'utf8')))
  } catch {
    return null // first run, or an unreadable file: start with the defaults
  }
}

function saveWindowState(win: BrowserWindow, previous: WindowState | null): WindowState {
  const state = snapshotWindowState(win.getNormalBounds(), win.isMaximized(), previous ?? undefined)
  try {
    mkdirSync(path.dirname(stateFile()), { recursive: true })
    writeFileSync(stateFile(), JSON.stringify(state))
  } catch {
    /* not being able to remember the window position is not worth an error dialog */
  }
  return state
}

// ---- session hardening ----

function hardenSession(): void {
  const csp = buildCsp({ devOrigin })
  const headers = securityHeaders(csp)

  // serve the built web app from a private origin, with the security headers on every response
  protocol.handle(APP_SCHEME, async (request) => {
    const file = resolveAppPath(webRoot, request.url)
    if (!file) return new Response('Not found', { status: 404, headers })
    try {
      const body = await readFile(file)
      return new Response(body, { status: 200, headers: { ...headers, 'Content-Type': mimeFor(file) } })
    } catch {
      return new Response('Not found', { status: 404, headers })
    }
  })

  const ses = session.defaultSession
  ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !isAllowedRequest(details.url, devOrigin) }))
  ses.webRequest.onHeadersReceived((details, callback) => {
    // the dev server does not send our headers, so add the (relaxed) policy to it
    if (devOrigin && details.url.startsWith(devOrigin)) callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } })
    else callback({})
  })
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)
  ses.setDevicePermissionHandler(() => false)
}

app.on('web-contents-created', (_event, contents) => {
  const guard = (event: Electron.Event, url: string) => {
    if (!isAllowedNavigation(url, devOrigin)) event.preventDefault()
  }
  contents.on('will-navigate', (event, url) => guard(event, url))
  contents.on('will-redirect', (event, url) => guard(event, url))
  contents.on('will-attach-webview', (event) => event.preventDefault())
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
})

// ---- menu ----

function buildMenu(): Menu {
  const view: MenuItemConstructorOptions[] = [
    { role: 'resetZoom' },
    { role: 'zoomIn' },
    { role: 'zoomOut' },
    { type: 'separator' },
    { role: 'togglefullscreen' },
    ...(app.isPackaged ? [] : ([{ type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' }] as MenuItemConstructorOptions[])),
  ]
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? ([{ role: 'appMenu' }] as MenuItemConstructorOptions[]) : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { label: 'View', submenu: view },
    { role: 'windowMenu' },
  ]
  return Menu.buildFromTemplate(template)
}

// ---- window ----

let mainWindow: BrowserWindow | null = null

function createWindow(): BrowserWindow {
  const saved = fitToDisplays(loadWindowState() ?? DEFAULT_WINDOW, screen.getAllDisplays().map((d) => d.workArea))
  let remembered: WindowState | null = saved

  const win = new BrowserWindow({
    ...(saved.x !== undefined && saved.y !== undefined ? { x: saved.x, y: saved.y } : {}),
    width: saved.width,
    height: saved.height,
    minWidth: MIN_WINDOW.width,
    minHeight: MIN_WINDOW.height,
    show: false, // shown once the first frame is ready, so there is no white flash
    backgroundColor: '#0a0a0f',
    title: 'Wavelocal',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
      // a music player must keep playing smoothly while hidden or minimized
      backgroundThrottling: false,
      devTools: !app.isPackaged,
      additionalArguments: [`--wl-app-version=${app.getVersion()}`],
    },
  })

  if (saved.maximized) win.maximize()
  win.once('ready-to-show', () => win.show())
  win.on('close', () => {
    remembered = saveWindowState(win, remembered)
  })
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

  void win.loadURL(devUrl ?? APP_URL)
  return win
}

// ---- lifecycle ----

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  void app.whenReady().then(() => {
    app.setAppUserModelId('app.wavelocal.desktop')
    hardenSession()
    Menu.setApplicationMenu(buildMenu())
    mainWindow = createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
