// Same-origin policy for the desktop routes.
//
// The desktop socket is the one place where this image hands out ambient
// authority: whoever reaches it drives a real browser with the container's
// cookies, files and network. DSH's own `/api` upgrade is fenced by Host +
// Origin; the desktop route must be fenced the same way, or any page the user
// visits could open `wss://<harness>/desktop/websockify` and take the desktop
// over (cross-site WebSocket hijacking).
//
// Only host and port are compared. The scheme cannot be derived inside the
// container: TLS terminates in front of it and the forwarding proxy
// deliberately strips `X-Forwarded-Proto` so a client cannot forge it.

/**
 * Lowercase an authority, drop a trailing FQDN dot and the default ports.
 * @param {string} authority `host`, `host:port`, or a bracketed IPv6 literal
 */
export function normalizeAuthority(authority) {
  const text = String(authority ?? '').trim().toLowerCase()
  if (text === '') return ''

  let host = text
  let port = ''
  if (text.startsWith('[')) {
    const end = text.indexOf(']')
    if (end === -1) return text
    host = text.slice(0, end + 1)
    const rest = text.slice(end + 1)
    if (rest.startsWith(':')) port = rest.slice(1)
    else if (rest !== '') return text
  } else {
    const colon = text.lastIndexOf(':')
    if (colon !== -1 && /^\d+$/.test(text.slice(colon + 1))) {
      host = text.slice(0, colon)
      port = text.slice(colon + 1)
    }
  }
  // The FQDN trailing dot belongs to the host part, not to the authority text.
  if (host.endsWith('.')) host = host.slice(0, -1)
  if (port === '' || port === '80' || port === '443') return host
  return `${host}:${port}`
}

/**
 * Whether a request's Origin names the same authority as its Host header.
 *
 * @param {import('node:http').IncomingMessage} request
 * @param {object} [options]
 * @param {boolean} [options.require] reject a request without an Origin header.
 *   Browsers always send Origin on a WebSocket handshake, so the upgrade route
 *   requires it; a non-browser POST client has no ambient credentials to abuse
 *   and may omit it.
 * @returns {boolean}
 */
export function isSameOriginRequest(request, { require = false } = {}) {
  const origin = request.headers.origin
  if (typeof origin !== 'string' || origin.trim() === '') return !require
  let url
  try {
    url = new URL(origin.trim())
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  const host = normalizeAuthority(request.headers.host)
  return host !== '' && normalizeAuthority(url.host) === host
}
