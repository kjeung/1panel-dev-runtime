// Static assets for the embedded noVNC client.
//
// The desktop lives under a path on the DSH origin instead of a port of its
// own, so the assets are served by the Harness web server that already sits
// behind the authenticating reverse proxy. Only files below `root` are
// reachable: the resolved real path is checked against the resolved root, which
// also covers symlinks inside the noVNC tree.
import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'

const CONTENT_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.ico', 'image/x-icon'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.ttf', 'font/ttf'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.wasm', 'application/wasm'],
])

export function contentType(file) {
  return CONTENT_TYPES.get(path.extname(file).toLowerCase()) ?? 'application/octet-stream'
}

/** Weak validator: no weak comparison needed beyond exact string match. */
export function entityTag(stats) {
  return `W/"${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}"`
}

function isFresh(request, stats, etag) {
  const noneMatch = request.headers['if-none-match']
  if (typeof noneMatch === 'string') {
    const candidates = noneMatch.split(',').map((value) => value.trim())
    if (candidates.includes('*') || candidates.includes(etag)) return true
  }
  const since = request.headers['if-modified-since']
  if (typeof since === 'string') {
    const stamp = Date.parse(since)
    if (!Number.isNaN(stamp) && Math.floor(stats.mtimeMs / 1000) * 1000 <= stamp) return true
  }
  return false
}

function send(response, status, headers, body) {
  response.writeHead(status, {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'same-origin',
    ...headers,
  })
  response.end(body)
}

/**
 * Resolve one request path to a regular file below `root`, or `null`.
 * @param {string} root real-path checked base directory
 * @param {string} relative path below the base, already URL-decoded
 */
export async function resolveAsset(root, relative, knownRealRoot) {
  if (relative.includes('\0')) return null
  const resolved = path.resolve(root, relative)
  const realRoot = knownRealRoot ?? (await realpath(root))
  const real = await realpath(resolved).catch(() => null)
  if (real === null) return null
  if (real !== realRoot && !real.startsWith(`${realRoot}${path.sep}`)) return null
  const stats = await stat(real).catch(() => null)
  if (stats === null || !stats.isFile()) return null
  return { file: real, stats }
}

/**
 * Build the request handler for the desktop prefix.
 * @param {object} options
 * @param {string} options.root absolute noVNC asset root
 * @param {string} options.basePath absolute mount path without a trailing slash
 * @param {(message: string) => void} [options.logger]
 * @returns {(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => Promise<void>}
 */
export function createStaticHandler({ root, basePath, logger = () => {} }) {
  const rootPath = path.resolve(root)
  let realRoot
  return async function handleDesktopAsset(request, response) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      send(response, 405, { allow: 'GET, HEAD', 'content-type': 'text/plain' }, 'method not allowed\n')
      return
    }
    let pathname
    try {
      const url = new URL(request.url ?? '/', 'http://desktop.invalid')
      pathname = decodeURIComponent(url.pathname)
    } catch {
      send(response, 400, { 'content-type': 'text/plain' }, 'bad request\n')
      return
    }
    if (pathname === basePath || pathname === `${basePath}/`) {
      // `/desktop` alone is a directory, not a client; send the viewer.
      response.writeHead(302, { location: `${basePath}/vnc.html`, 'cache-control': 'no-store' })
      response.end()
      return
    }
    if (!pathname.startsWith(`${basePath}/`)) {
      send(response, 404, { 'content-type': 'text/plain' }, 'not found\n')
      return
    }

    realRoot ??= await realpath(rootPath).catch(() => null)
    const asset = realRoot === null
      ? null
      : await resolveAsset(rootPath, pathname.slice(basePath.length + 1), realRoot)
    if (asset === null) {
      logger(`desktop asset not found: ${pathname.slice(basePath.length)}`)
      send(response, 404, { 'content-type': 'text/plain' }, 'not found\n')
      return
    }

    const etag = entityTag(asset.stats)
    if (isFresh(request, asset.stats, etag)) {
      response.writeHead(304, {
        etag,
        'cache-control': 'no-cache',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'same-origin',
      })
      response.end()
      return
    }

    const headers = {
      'content-type': contentType(asset.file),
      'content-length': String(asset.stats.size),
      'last-modified': asset.stats.mtime.toUTCString(),
      etag,
      // Revalidate on every load: a container upgrade must not mix a cached
      // rfb.js with a newer app/ui.js from the same prefix.
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'same-origin',
    }
    if (request.method === 'HEAD') {
      response.writeHead(200, headers)
      response.end()
      return
    }
    response.writeHead(200, headers)
    const stream = createReadStream(asset.file)
    stream.on('error', (error) => {
      logger(`desktop asset read failed: ${error.message}`)
      response.destroy()
    })
    response.on('close', () => stream.destroy())
    stream.pipe(response)
  }
}
