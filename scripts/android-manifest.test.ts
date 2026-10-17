// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

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
