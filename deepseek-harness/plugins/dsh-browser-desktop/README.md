# `@1panel/dsh-browser-desktop`

A visible Chromium desktop and human-takeover layer for DeepSeek Harness. It
embeds the container's browser in a movable, resizable noVNC panel inside the
Harness UI, and registers the `browser_open` bridge so an Agent can reveal the
same browser to the user.

This package is a **vendored adaptation** of
[`@runzhliu/dsh-browser-desktop`](https://github.com/runzhliu/deepseek-harness-docker/tree/main/plugins/dsh-browser-desktop)
(MIT, see [LICENSE](LICENSE)). The upstream project publishes noVNC on a second
port and rewrites the browser URL's port. This image publishes exactly one port
(`8080`, plain HTTP, behind the operator's TLS + auth proxy), so the viewer is
mounted **on the Harness origin** instead:

| | upstream | here |
| --- | --- | --- |
| viewer URL | `https://host:6080/vnc.html` | `https://host/desktop/vnc.html` |
| static assets | `websockify --web=/usr/share/novnc` | `ctx.webServer` prefix route |
| RFB transport | websockify (Python) | in-process WebSocket→TCP bridge (`ws-bridge.js`) |
| RFB endpoint | `127.0.0.1:5900` | same, reached only from the Harness process |
| extra container port | 6080 | none |
| auth / TLS | operator's proxy on two entry points | operator's existing single entry point |

The panel is therefore same-origin with the UI it lives in: one Authentik
application, one certificate, one Traefik router, one set of cookies, and the
existing `node-proxy` Host allowlist (plus optional `PROXY_SHARED_SECRET`)
covers the desktop exactly as it covers `/api`. See
[`docs/adr/0001`](../../../docs/adr/0001-browser-desktop-access.md) for the
subdomain / sub-path / non-standard-port comparison this decision came from.

## Tests

`deepseek-harness/test-desktop.mjs` runs during the image build (`node --test`)
and covers the path geometry, the static handler (traversal, symlink escape,
revalidation), the frame codec, and a live bridge against an echo socket. The
plugin-wiring case imports `index.js`, which resolves `@deepseek-ai/schemastery`
from the image; run it in the build or link that package into
`plugins/dsh-browser-desktop/node_modules` first.

## Routes

| Route | Kind | Purpose |
| --- | --- | --- |
| `/desktop/*` | HTTP prefix | noVNC 1.6 assets, revalidated on every load |
| `/desktop/websockify` | WebSocket upgrade | RFB over WebSocket, bridged to x11vnc; Origin must equal Host |
| `/browser-desktop/state` | HTTP exact | panel state + viewer path + poll interval |
| `/browser-desktop/open` | HTTP exact (POST) | `browser_open` over CDP, same-origin only |

`/desktop` redirects to the configured viewer (autoconnect and the pinned socket
path included). The viewer URL carries an explicit
`path=/desktop/websockify` query parameter, so noVNC never guesses the
socket location from the page URL.

## Configuration

The image ships the defaults; override them in the Cordis patch entry
(`deepseek-harness/web-desktop.cordis.patch.yml`) when the desktop stack moves.

| Field | Default | Meaning |
| --- | --- | --- |
| `cdpBaseUrl` | `http://127.0.0.1:9222` | Chromium DevTools endpoint used by `browser_open` |
| `desktopBasePath` | `/desktop` | mount path for the viewer assets |
| `desktopPath` | `/vnc.html?autoconnect=1&resize=scale&view_only=0&reconnect=1` | viewer page below the base path |
| `wsPath` | `<desktopBasePath>/websockify` | upgrade route bridged to the RFB server |
| `novncRoot` | `/usr/share/novnc` | noVNC 1.6 asset root inside the image |
| `vncHost` / `vncPort` | `127.0.0.1` / `5900` | x11vnc loopback endpoint |
| `pingIntervalMs` | `30000` | WebSocket keep-alive ping (idle proxies) |
| `pollIntervalMs` | `750` | how often the panel polls `/browser-desktop/state` |

## Security

The desktop is a real browser with the container's network position and its
persisted profile (`/data/dsh/chrome-profile`). Whoever reaches
`/desktop/websockify` owns that desktop. The image relies on the operator's
reverse proxy for authentication exactly as it does for the Harness UI:

- the RFB upgrade is fenced like Harness' own `/api` socket: the request's `Origin`
  must name the same host (and port) as its `Host` header, and a handshake without
  `Origin` is refused. Without that fence any page the user visits could open
  `wss://<harness>/desktop/websockify` with the browser's ambient credentials and
  take the desktop over (cross-site WebSocket hijacking);
- the viewer document is served with `frame-ancestors 'self'` + `X-Frame-Options:
  SAMEORIGIN`, so only the Harness UI on this origin may frame it;
- keep port `8080` reachable only from the authenticated proxy;
- keep the authenticating middleware on the whole router, including the
  WebSocket upgrade;
- do not add `buffering` or `compress` middleware: both the desktop socket and
  the Harness SSE stream break under them;
- `x11vnc` binds loopback with `-localhost -nopw`, and Chromium's DevTools port
  binds `127.0.0.1` only.

## Behaviour notes

- **No `--no-sandbox` weakening beyond the browser.** This image installs neither
  the setuid `chromium-sandbox` helper nor an unprivileged user namespace, so
  Chromium reports `No usable sandbox!`; only the `chromium-docker` wrapper
  passes `--no-sandbox`, scoped to that process. The reference compose also sets
  `no-new-privileges`, which forecloses the setuid-helper option on purpose.
- **The panel survives Chromium restarts.** `desktop-supervisor.sh` restarts the
  browser and the RFB server, while the bridge reports a closed socket to the
  browser so noVNC reconnects instead of hanging.
- **A Harness restart ends the desktop stream.** The bridge lives inside the
  Harness web server; restarting the container drops the VNC session and keeps
  the browser profile.
- **Browser Use is per-Session and does not survive a browser restart.** Within
  one provider instance a single live Session owns the attached browser; other
  Sessions continue without Browser Use (the panel and `browser_open` remain
  usable). The supervisor restarts Chromium after a crash or a manual stop, and
  the provider does not reconnect: create or resume a Session to get the
  tools back. The noVNC panel, by contrast, reconnects on its own.
