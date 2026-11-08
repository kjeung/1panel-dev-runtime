// Geometry helpers for the desktop plugin.
//
// Everything here is pure (no I/O, no DSH imports) so the container build test
// can exercise it without a mounted plugin graph. The desktop is served from a
// same-origin path on the DSH listener, never from a second port, so every URL
// this module returns is a path on the current origin.

/** Absolute pathname without a trailing slash, no dot segments. */
export function normalizeBasePath(input, fallback = '/desktop') {
  const value = typeof input === 'string' && input.trim() !== '' ? input.trim() : fallback
  const url = new URL(value, 'http://desktop.invalid')
  const path = url.pathname.replace(/\/+$/, '')
  if (path === '') throw new Error('desktopBasePath must not be the origin root')
  if (url.search !== '' || url.hash !== '') {
    throw new Error('desktopBasePath must be a path without query or fragment')
  }
  return path
}

/** Same-origin absolute page path; rejects any other origin. */
export function normalizePagePath(input, fallback) {
  const value = typeof input === 'string' && input.trim() !== '' ? input.trim() : fallback
  const url = new URL(value, 'http://desktop.invalid')
  if (url.origin !== 'http://desktop.invalid') {
    throw new Error('desktopPath must be a same-origin absolute path')
  }
  return `${url.pathname}${url.search}${url.hash}`
}

/**
 * WebSocket path for the RFB bridge. noVNC resolves its default relative
 * `path` against the page URL, but the sidebar can also open the panel from
 * another route, so the bridge path is passed explicitly and must stay
 * same-origin.
 */
export function normalizeSocketPath(input, basePath, fallbackName = 'websockify') {
  const value = typeof input === 'string' && input.trim() !== '' ? input.trim() : `${basePath}/${fallbackName}`
  const url = new URL(value, 'http://desktop.invalid')
  if (url.origin !== 'http://desktop.invalid') {
    throw new Error('wsPath must be a same-origin absolute path')
  }
  if (!url.pathname.startsWith(`${basePath}/`)) {
    throw new Error(`wsPath must live under ${basePath}`)
  }
  if (url.search !== '' || url.hash !== '') {
    throw new Error('wsPath must not carry a query or fragment')
  }
  return url.pathname
}

/**
 * Value passed to noVNC's `path` query parameter. noVNC 1.6 resolves it with
 * `new URL(path, location.href)`, so an absolute path is stable no matter how
 * deep the viewer page sits; a bare `websockify` would only work while the
 * viewer stays a direct child of the desktop prefix.
 */
export function socketPathParameter(socketPath, basePath) {
  const prefix = `${basePath}/`
  if (!socketPath.startsWith(prefix)) throw new Error(`socket path must live under ${basePath}`)
  return socketPath
}

export function isPort(value) {
  return Number.isInteger(value) && value >= 1 && value <= 65535
}

/**
 * The viewer URL the panel embeds. `pagePath` is relative to the desktop mount
 * point (upstream's `desktopPath` convention), and the RFB path is pinned
 * explicitly so the socket always lands on the route the plugin registered,
 * even when the page is opened by hand or bookmarked with other parameters.
 */
export function viewerPath(pagePath, socketPath, basePath) {
  const relative = normalizePagePath(pagePath, '/vnc.html')
  const joined = new URL(`${basePath}${relative}`, 'http://desktop.invalid')
  if (!joined.pathname.startsWith(`${basePath}/`) || joined.pathname === `${basePath}/`) {
    throw new Error(`desktopPath must name a page below ${basePath}`)
  }
  joined.searchParams.set('path', socketPathParameter(socketPath, basePath))
  return `${joined.pathname}${joined.search}${joined.hash}`
}
