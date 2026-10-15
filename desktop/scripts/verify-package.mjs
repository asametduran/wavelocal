// Checks the output of `electron-builder` so a CI run fails loudly if the installer is missing pieces:
// the installer exists and is non-trivial, and the unpacked app has the web build beside an asar that holds the shell.
// Uses only Node built-ins plus the asar reader that ships with electron-builder.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const release = path.join(desktop, 'release')
const version = JSON.parse(readFileSync(path.join(desktop, 'package.json'), 'utf8')).version
const problems = []
const fail = (message) => problems.push(message)

const installer = path.join(release, `Wavelocal-Setup-${version}-x64.exe`)
if (!existsSync(installer)) fail(`installer not found: ${installer}`)
else if (statSync(installer).size < 50 * 1024 * 1024) fail(`installer is suspiciously small (${statSync(installer).size} bytes)`)

const resources = path.join(release, 'win-unpacked', 'resources')
const web = path.join(resources, 'web')
if (!existsSync(path.join(web, 'index.html'))) fail('resources/web/index.html is missing: the web build was not bundled')
else if (!readdirSync(web).includes('assets')) fail('resources/web/assets is missing')
if (!existsSync(path.join(release, 'win-unpacked', 'Wavelocal.exe'))) fail('Wavelocal.exe is missing from win-unpacked')

const asarFile = path.join(resources, 'app.asar')
if (!existsSync(asarFile)) fail('resources/app.asar is missing')
else {
  const require = createRequire(import.meta.url)
  const asar = require('@electron/asar')
  const entries = asar.listPackage(asarFile).map((entry) => entry.replaceAll('\\', '/').replace(/^\//, ''))
  for (const wanted of ['package.json', 'out/desktop/src/main.js', 'out/desktop/src/preload.js', 'out/src/desktop-bridge.js']) {
    if (!entries.includes(wanted)) fail(`app.asar is missing ${wanted}`)
  }
  const stray = entries.filter((entry) => /\.test\.js$|\.map$|\.ts$/.test(entry))
  if (stray.length) fail(`app.asar contains files that should not ship: ${stray.slice(0, 5).join(', ')}`)
}

if (problems.length) {
  console.error(`Package verification failed:\n - ${problems.join('\n - ')}`)
  process.exit(1)
}
console.log(`Package verified: ${path.relative(desktop, installer)}`)
