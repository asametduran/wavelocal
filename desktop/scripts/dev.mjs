// Development launcher: compiles the shell, starts the Vite dev server, waits for it, opens Electron on it,
// and shuts everything down together. Uses only Node built-ins, and runs the tools through node (no shell).
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const root = path.resolve(desktop, '..')
const require = createRequire(import.meta.url)
const port = Number(process.env.PORT ?? 5173)
const url = `http://127.0.0.1:${port}`

const run = (script, args, options = {}) => spawn(process.execPath, [script, ...args], { stdio: 'inherit', ...options })

function waitForServer(target, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const attempt = () => {
      http
        .get(target, (res) => {
          res.resume()
          resolve()
        })
        .on('error', () => {
          if (Date.now() > deadline) reject(new Error(`Timed out waiting for ${target}`))
          else setTimeout(attempt, 250)
        })
    }
    attempt()
  })
}

// 1. compile the main process and preload
await new Promise((resolve, reject) => {
  const tsc = run(path.join(desktop, 'node_modules', 'typescript', 'bin', 'tsc'), ['-p', 'tsconfig.build.json'], { cwd: desktop })
  tsc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`tsc exited with ${code}`))))
})

// 2. start the web app's dev server
const vite = run(path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), ['--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: root })
let electron = null
const shutdown = (code = 0) => {
  electron?.kill()
  vite.kill()
  process.exit(code)
}
process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))
vite.on('exit', (code) => shutdown(code ?? 0))

// 3. open Electron on it
await waitForServer(url)
electron = spawn(require('electron'), ['.'], { cwd: desktop, stdio: 'inherit', env: { ...process.env, WAVELOCAL_DEV_URL: url } })
electron.on('exit', (code) => shutdown(code ?? 0))
