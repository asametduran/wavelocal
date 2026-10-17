import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { extname, join, normalize, sep } from 'node:path'

/**
 * A static file server that tests can steer: stop it (the network is gone), bring it back on the same address, serve another
 * release from another folder, or answer one path with something else (a hotel's sign-in page, a broken file). The service
 * worker tests need a real server because a worker does its own fetching, which a mocked request cannot reach.
 */

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
}

export interface Override {
  status: number
  body: string
  type?: string
}

export interface Site {
  /** `http://127.0.0.1:<port>`, the same for the whole life of the site, also across `down()` and `up()`. */
  readonly origin: string
  /** Paths requested since the start or the last `forget()`, in order, without query strings. */
  readonly requests: string[]
  /** Serve this folder from now on (a new release). */
  serve(root: string): void
  /** Answer one path with something else; `null` goes back to the file. */
  override(path: string, answer: Override | null): void
  /** Stop answering: the browser sees a refused connection, like having no network. */
  down(): Promise<void>
  up(): Promise<void>
  forget(): void
  close(): Promise<void>
}

export async function startSite(initialRoot: string): Promise<Site> {
  let root = initialRoot
  const overrides = new Map<string, Override>()
  const requests: string[] = []
  const server: Server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url ?? '/', 'http://site').pathname)
    requests.push(path)
    const forced = overrides.get(path)
    if (forced) {
      response.writeHead(forced.status, { 'content-type': forced.type ?? 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      response.end(forced.body)
      return
    }
    const relative = normalize(path === '/' ? 'index.html' : path.slice(1))
    const file = join(root, relative)
    if (relative.startsWith('..') || !file.startsWith(root + sep) || !existsSync(file) || !statSync(file).isFile()) {
      response.writeHead(404, { 'content-type': 'text/plain' })
      response.end('not found')
      return
    }
    // like a real host: the shell and the worker are revalidated every time, hashed files may be kept for a year
    const hashed = relative.startsWith(`assets${sep}`)
    response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache' })
    createReadStream(file).pipe(response)
  })

  const listen = (port: number) => new Promise<void>((resolve, reject) => server.once('error', reject).listen(port, '127.0.0.1', resolve))
  await listen(0)
  const port = (server.address() as AddressInfo).port

  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    serve(next) {
      root = next
    },
    override(path, answer) {
      if (answer) overrides.set(path, answer)
      else overrides.delete(path)
    },
    async down() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
    },
    up: () => listen(port),
    forget() {
      requests.length = 0
    },
    async close() {
      await new Promise<void>((resolve) => {
        if (!server.listening) return resolve()
        server.close(() => resolve())
        server.closeAllConnections()
      })
    },
  }
}
