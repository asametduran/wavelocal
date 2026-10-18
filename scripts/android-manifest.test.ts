// @vitest-environment node
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SHARE_DIR } from '../src/lib/savefile/native'

// The Android app cannot be built on every machine, so its privacy and security settings are held in place here: a test
// that reads the manifest, the policy files it points to, and the Capacitor config. A setting that drifts fails CI.

const root = join(__dirname, '..')
const main = join(root, 'android', 'app', 'src', 'main')
const read = (path: string): string => readFileSync(path, 'utf8').replace(/<!--[\s\S]*?-->/g, '')
const manifest = read(join(main, 'AndroidManifest.xml'))

/** Attributes of one opening tag, by name (`android:allowBackup` -> `false`). */
function attributes(tag: string): Record<string, string> {
  const found: Record<string, string> = {}
  for (const match of tag.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) found[match[1] as string] = match[2] as string
  return found
}

/** Every `<name ...>` element of the manifest with its attributes and its inner text. */
function elements(xml: string, name: string): { attrs: Record<string, string>; body: string }[] {
  const out: { attrs: Record<string, string>; body: string }[] = []
  for (const match of xml.matchAll(new RegExp(`<${name}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${name}>)`, 'g'))) out.push({ attrs: attributes(match[1] ?? ''), body: match[2] ?? '' })
  return out
}

const application = elements(manifest, 'application')[0]?.attrs ?? {}
const resource = (reference: string | undefined, folder: string): string => {
  const match = /^@xml\/([\w]+)$/.exec(reference ?? '')
  if (!match) throw new Error(`not an @xml reference: ${reference}`)
  const path = join(main, 'res', folder, `${match[1]}.xml`)
  expect(existsSync(path), `${path} must exist`).toBe(true)
  return read(path)
}

describe('backups', () => {
  it('are switched off, so the library cannot be copied into a cloud backup or by adb', () => {
    expect(application['android:allowBackup']).toBe('false')
  })

  it('are also excluded by the Android 12 rules for cloud backup and device transfer', () => {
    const rules = resource(application['android:dataExtractionRules'], 'xml')
    for (const section of ['cloud-backup', 'device-transfer']) {
      const block = elements(rules, section)[0]?.body ?? ''
      for (const domain of ['root', 'file', 'database', 'sharedpref', 'external']) {
        expect(block, `${section} must exclude ${domain}`).toMatch(new RegExp(`<exclude\\s+domain="${domain}"`))
      }
      expect(block, `${section} must not include anything`).not.toMatch(/<include\b/)
    }
  })
})

describe('network', () => {
  it('refuses plain-text HTTP', () => {
    expect(application['android:usesCleartextTraffic']).toBe('false')
  })

  it('has a security config that refuses cleartext everywhere and trusts only system certificates', () => {
    const config = resource(application['android:networkSecurityConfig'], 'xml')
    expect(config).toMatch(/<base-config[^>]*cleartextTrafficPermitted="false"/)
    expect(config).not.toMatch(/cleartextTrafficPermitted="true"/)
    expect(config).not.toMatch(/<certificates[^>]*src="user"/)
    expect(config).not.toMatch(/<domain-config/)
    expect(config).not.toMatch(/<debug-overrides/)
    expect(config).toMatch(/<certificates\s+src="system"/)
  })

  it('asks for the internet permission and nothing else: no storage, microphone, camera, location or contacts', () => {
    const permissions = elements(manifest, 'uses-permission').map((p) => p.attrs['android:name'])
    expect(permissions).toEqual(['android.permission.INTERNET'])
  })

  it('does not point the WebView at a development server or allow plain HTTP in the Capacitor config', () => {
    const config = JSON.parse(readFileSync(join(root, 'capacitor.config.json'), 'utf8')) as { server?: { url?: string; cleartext?: boolean; allowNavigation?: string[] } }
    expect(config.server?.url).toBeUndefined()
    expect(config.server?.cleartext).not.toBe(true)
    expect(config.server?.allowNavigation ?? []).toEqual([])
  })
})

describe('components', () => {
  it('declare whether they can be started from outside, as Android 12 requires', () => {
    for (const name of ['activity', 'service', 'receiver', 'provider']) {
      for (const { attrs, body } of elements(manifest, name)) {
        if (name === 'provider' || /<intent-filter/.test(body)) expect(attrs['android:exported'], `${name} ${attrs['android:name']}`).toMatch(/^(true|false)$/)
      }
    }
  })

  it('open only the launcher activity to other apps, and keep the file provider private', () => {
    const exported = elements(manifest, 'activity').filter((a) => a.attrs['android:exported'] === 'true')
    expect(exported.map((a) => a.attrs['android:name'])).toEqual(['.MainActivity'])
    for (const provider of elements(manifest, 'provider')) expect(provider.attrs['android:exported']).toBe('false')
    expect(elements(manifest, 'service')).toHaveLength(0)
    expect(elements(manifest, 'receiver')).toHaveLength(0)
  })

  it('leave out the settings that weaken an app', () => {
    for (const setting of ['android:debuggable', 'android:requestLegacyExternalStorage', 'android:sharedUserId', 'android:testOnly']) {
      expect(manifest, setting).not.toContain(setting)
    }
  })
})

// Saving a file in the Android app writes it to the app's cache folder and hands it to the share sheet (src/lib/savefile): no storage
// permission is asked for, and the one way out is the app's own file provider.
describe('sharing a file', () => {
  const provider = elements(manifest, 'provider').find((p) => p.attrs['android:name'] === 'androidx.core.content.FileProvider')

  it('goes out through the app’s own file provider, with the authority the Share plugin builds its addresses with', () => {
    expect(provider, 'the FileProvider must be declared').toBeDefined()
    expect(provider?.attrs['android:authorities']).toBe('${applicationId}.fileprovider')
  })

  it('keeps that provider private: it only serves the files the app hands to the share sheet', () => {
    expect(provider?.attrs['android:exported']).toBe('false')
    expect(provider?.attrs['android:grantUriPermissions']).toBe('true')
  })

  it('reaches the cache folder the files are written to', () => {
    const meta = elements(provider?.body ?? '', 'meta-data').find((m) => m.attrs['android:name'] === 'android.support.FILE_PROVIDER_PATHS')
    const paths = resource(meta?.attrs['android:resource'], 'xml')
    const cache = elements(paths, 'cache-path').map((c) => (c.attrs.path ?? '').replace(/^\.?\/*|\/+$/g, ''))
    expect(cache.some((path) => path === '' || path === SHARE_DIR), `a cache-path must cover ${SHARE_DIR}`).toBe(true)
  })
})

// The Capacitor plugins are dependencies so that `npx cap sync` wires their native halves into the Android project, which is
// committed. Their own code is not in the web bundle (see the next block). Adding a plugin means adding it here, which is the
// moment to read its manifest: the tests below then hold it to the same rules as the app.
describe('the Capacitor plugins', () => {
  const dependencies = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }).dependencies
  const PLATFORM = new Set(['core', 'android', 'ios', 'cli'])
  const plugins = Object.keys(dependencies)
    .filter((name) => name.startsWith('@capacitor/'))
    .map((name) => name.slice('@capacitor/'.length))
    .filter((name) => !PLATFORM.has(name))
    .sort()

  it('are the three the app uses: the Back button (app), and saving (filesystem) and sharing (share) a file', () => {
    expect(plugins).toEqual(['app', 'filesystem', 'share'])
  })

  it('are all wired into the Android project, so that a forgotten `cap sync` fails here and not in the APK build', () => {
    const settings = read(join(root, 'android', 'capacitor.settings.gradle'))
    const build = read(join(root, 'android', 'app', 'capacitor.build.gradle'))
    for (const name of plugins) {
      expect(settings, `${name} in capacitor.settings.gradle`).toContain(`include ':capacitor-${name}'`)
      expect(settings, `${name} in capacitor.settings.gradle`).toContain(`new File('../node_modules/@capacitor/${name}/android')`)
      expect(build, `${name} in capacitor.build.gradle`).toContain(`implementation project(':capacitor-${name}')`)
    }
  })

  it('wire in nothing else: the project holds the Android runtime and these plugins', () => {
    const included = [...read(join(root, 'android', 'capacitor.settings.gradle')).matchAll(/include ':capacitor-([\w-]+)'/g)].map((m) => m[1]).sort()
    expect(included).toEqual(['android', ...plugins].sort())
  })

  it('are checked by a reader that can see what it is looking for (a control on the next test)', () => {
    const xml = '<manifest><uses-permission android:name="android.permission.CAMERA" /><queries><package android:name="x" /></queries><application><provider android:name="p"></provider><service android:name="s"/></application></manifest>'
    for (const tag of ['uses-permission', 'queries', 'application', 'provider', 'service']) expect(elements(xml, tag), tag).toHaveLength(1)
  })

  it('ask for no permission and declare no component of their own, so that the merged manifest is the app’s', () => {
    for (const name of plugins) {
      const path = join(root, 'node_modules', '@capacitor', name, 'android', 'src', 'main', 'AndroidManifest.xml')
      expect(existsSync(path), `${name} must have an Android manifest to read`).toBe(true)
      const xml = read(path)
      for (const tag of ['uses-permission', 'uses-permission-sdk-23', 'uses-feature', 'uses-sdk', 'queries', 'application', 'activity', 'service', 'receiver', 'provider']) {
        expect(elements(xml, tag), `${name} must not declare <${tag}>`).toHaveLength(0)
      }
    }
  })
})

// The app is dark whatever the phone's setting (`class="dark"`, `color-scheme: dark`). Capacitor's SystemBars plugin picks the colour of
// the icons of the status and gesture bars from the phone's day/night setting unless told otherwise, which on a phone in light mode
// gives dark icons on a dark page, and the theme's window background shows behind the bars on an older WebView and until the page paints.
describe('the system bars', () => {
  const config = JSON.parse(readFileSync(join(root, 'capacitor.config.json'), 'utf8')) as { plugins?: { SystemBars?: { style?: string; initialViewportFitValueHint?: string } } }
  const html = readFileSync(join(root, 'index.html'), 'utf8')
  const styles = read(join(main, 'res', 'values', 'styles.xml'))
  const colors = read(join(main, 'res', 'values', 'colors.xml'))

  it('have light icons, whatever the phone’s day/night setting', () => {
    expect(config.plugins?.SystemBars?.style).toBe('DARK')
  })

  it('know that the page covers the whole screen (viewport-fit=cover), so that nothing shifts when the page appears', () => {
    expect(html).toMatch(/<meta\s+name="viewport"[^>]*viewport-fit=cover/)
    expect(config.plugins?.SystemBars?.initialViewportFitValueHint).toBe('cover')
  })

  it('have the page’s own colour behind them, in the theme the activity runs in and before the page has painted', () => {
    const theme = elements(styles, 'style').find((style) => style.attrs.name === 'AppTheme.NoActionBar')
    const background = elements(theme?.body ?? '', 'item').find((item) => item.attrs.name === 'android:windowBackground')?.body.trim()
    expect(background).toBe('@color/wavelocal_background')
    const color = elements(colors, 'color').find((c) => c.attrs.name === 'wavelocal_background')?.body.trim()
    const themeColor = /<meta\s+name="theme-color"\s+content="(#[0-9a-fA-F]{6})"/.exec(html)?.[1]
    expect(themeColor, 'index.html must name a theme-color').toBeDefined()
    expect(color?.toLowerCase()).toBe(themeColor?.toLowerCase())
  })
})

describe('the web bundle', () => {
  const sources = (readdirSync(join(root, 'src'), { recursive: true }) as string[])
    .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file) && !/(^|[\\/])test-utils[\\/]/.test(file))
    .map((file) => file.replaceAll('\\', '/'))

  it('loads Capacitor from two lazy modules only: the Android saver and the Android shell', () => {
    const importing = sources.filter((file) => /(?:from|import\(|require\()\s*['"]@capacitor\//.test(readFileSync(join(root, 'src', file), 'utf8')))
    expect(importing.sort()).toEqual(['lib/androidshell.ts', 'lib/savefile/plugins.ts'])
  })
})
