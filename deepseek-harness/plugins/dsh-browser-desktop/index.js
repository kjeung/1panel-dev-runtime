// Visible Chromium desktop for DeepSeek Harness: model bridge + same-origin
// noVNC panel.
//
// This is the 1Panel adaptation of `@runzhliu/dsh-browser-desktop` (MIT, see
// LICENSE). Upstream expects noVNC on a second published port and rewrites the
// browser URL's port; this image publishes exactly one port, so the viewer is
// mounted under a same-origin path on the Harness web server and the RFB
// socket is bridged to x11vnc in-process. See docs/adr/0001 for the reasoning.
import { existsSync } from 'node:fs'

import z from '@deepseek-ai/schemastery'

import {
  isPort,
  normalizeBasePath,
  normalizePagePath,
  normalizeSocketPath,
  viewerPath,
} from './paths.js'
import { createStaticHandler } from './static.js'
import { acceptUpgrade, bridgeToTcp } from './ws-bridge.js'

export { viewerPath }

export const name = 'browser-desktop'
export const inject = ['tools', 'systemPrompt', 'webServer']

const defaultDesktopPath = '/vnc.html?autoconnect=1&resize=scale&view_only=0&reconnect=1'

export const Config = z.object({
  cdpBaseUrl: z.string().min(1).default('http://127.0.0.1:9222'),
  desktopBasePath: z.string().min(1).default('/desktop'),
  desktopPath: z.string().min(1).default(defaultDesktopPath),
  wsPath: z.string().default(''),
  novncRoot: z.string().min(1).default('/usr/share/novnc'),
  vncHost: z.string().min(1).default('127.0.0.1'),
  vncPort: z.number().step(1).min(1).max(65535).default(5900),
  pingIntervalMs: z.number().step(1).min(1000).max(600000).default(30000),
  pollIntervalMs: z.number().step(1).min(250).max(10000).default(750),
})

function normalizeBaseUrl(input) {
  const parsed = new URL(input)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('cdpBaseUrl must use http:// or https://')
  }
  return parsed.toString().replace(/\/$/, '')
}

function normalizeUrl(input) {
  const value = input.trim()
  if (value.length === 0) throw new Error('url must be a non-empty string')

  const parsed = new URL(value.includes('://') ? value : `https://${value}`)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('only http:// and https:// URLs can be opened')
  }
  return parsed.toString()
}


function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

async function readJson(req) {
  let body = ''
  for await (const chunk of req) {
    body += chunk
    if (body.length > 16384) throw new Error('request body is too large')
  }
  if (body.length === 0) throw new Error('request body is required')
  return JSON.parse(body)
}

function isSameOrigin(req) {
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

export function apply(ctx, config = {}) {
  const cdpBase = normalizeBaseUrl(config.cdpBaseUrl ?? 'http://127.0.0.1:9222')
  const basePath = normalizeBasePath(config.desktopBasePath)
  const socketPath = normalizeSocketPath(config.wsPath, basePath)
  const pagePath = viewerPath(normalizePagePath(config.desktopPath, defaultDesktopPath), socketPath, basePath)
  const novncRoot = config.novncRoot ?? '/usr/share/novnc'
  const vncPort = isPort(config.vncPort) ? config.vncPort : 5900
  const pollIntervalMs = config.pollIntervalMs ?? 750
  const pingIntervalMs = config.pingIntervalMs ?? 30_000

  const log = (level, message) => {
    const logger = ctx.logger
    const write = logger?.[level]
    if (typeof write === 'function') write.call(logger, `browser-desktop: ${message}`)
  }

  let state = {
    revision: 0,
    url: null,
    openedAt: 0,
  }

  async function cdpFetch(path, init, signal) {
    let lastError
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        const response = await fetch(`${cdpBase}${path}`, { ...init, signal })
        if (!response.ok) throw new Error(`Chromium DevTools returned HTTP ${response.status}`)
        return response
      } catch (error) {
        lastError = error
        if (signal?.aborted) throw error
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
    }
    throw lastError
  }

  async function openUrl(input, signal) {
    const url = normalizeUrl(input)
    const response = await cdpFetch(`/json/new?${encodeURIComponent(url)}`, { method: 'PUT' }, signal)
    const target = await response.json()
    await cdpFetch(`/json/activate/${encodeURIComponent(target.id)}`, {}, signal)
    state = {
      revision: state.revision + 1,
      url,
      openedAt: Date.now(),
    }
    return { url, status: 'opened' }
  }

  ctx.systemPrompt.section({
    name: 'tool:browser_open',
    order: 115,
    text: 'Use browser_open only when the user asks to open, show, or hand off a URL in the visible browser desktop. It opens the persistent container Chromium and reveals it for human takeover. When Browser Use tools are available, use those tools for page inspection and interaction instead of treating browser_open as an automation tool. Do not investigate or reinstall the browser, x11vnc, noVNC, or the desktop bridge.',
  })

  ctx.tools.register({
    name: 'browser_open',
    description: 'Open an HTTP or HTTPS URL in the visible persistent Chromium desktop and reveal it for human takeover. Use Browser Use tools for page inspection and interaction.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        url: {
          type: 'string',
          description: 'The URL to open. A missing scheme defaults to https://.',
        },
      },
      required: ['url'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string' },
          status: { type: 'string' },
        },
        required: ['url', 'status'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Opened ${value.url} in the embedded browser.`,
      }],
    },
    async execute(args, exec) {
      if (typeof args?.url !== 'string') throw new Error('url must be a string')
      return openUrl(args.url, exec.signal)
    },
  })

  ctx.effect(() => {
    const disposers = []
    const bridges = new Set()

    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/browser-desktop/state',
      handler(req, res) {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405)
          res.end()
          return
        }
        if (req.method === 'HEAD') {
          res.writeHead(200, { 'cache-control': 'no-store' })
          res.end()
          return
        }
        sendJson(res, 200, {
          ...state,
          desktop: { path: pagePath, socketPath },
          pollIntervalMs,
        })
      },
    }))

    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/browser-desktop/open',
      async handler(req, res) {
        if (req.method !== 'POST') {
          res.writeHead(405)
          res.end()
          return
        }
        if (!isSameOrigin(req)) {
          sendJson(res, 403, { error: 'cross-origin requests are not allowed' })
          return
        }
        try {
          const input = await readJson(req)
          if (typeof input?.url !== 'string') throw new Error('url must be a string')
          sendJson(res, 200, await openUrl(input.url))
        } catch (error) {
          sendJson(res, 400, {
            error: error instanceof Error ? error.message : 'unable to open URL',
          })
        }
      },
    }))

    if (!existsSync(novncRoot)) {
      // A build without the desktop layer still loads the plugin so that the
      // tool and the panel keep their documented behavior; only the viewer is
      // missing, and the 404 that follows says so.
      log('warn', `noVNC assets are missing at ${novncRoot}; the desktop viewer will not be served`)
    } else {
      disposers.push(ctx.webServer.register({
        kind: 'prefix',
        path: basePath,
        handler: createStaticHandler({
          root: novncRoot,
          basePath,
          logger: (message) => log('info', message),
        }),
      }))
      disposers.push(ctx.webServer.registerUpgrade({
        path: socketPath,
        handler(request, socket, head) {
          if (!acceptUpgrade(request, socket, (message) => log('warn', message))) return
          const bridge = bridgeToTcp({
            socket,
            head,
            host: config.vncHost ?? '127.0.0.1',
            port: vncPort,
            pingIntervalMs,
            logger: (message) => log('info', message),
          })
          bridges.add(bridge)
          socket.once('close', () => bridges.delete(bridge))
        },
      }))
      log('info', `desktop viewer at ${pagePath} (RFB ${config.vncHost ?? '127.0.0.1'}:${vncPort} via ${socketPath})`)
    }

    return () => {
      for (const bridge of bridges) bridge.close()
      bridges.clear()
      for (const dispose of disposers.reverse()) dispose()
    }
  }, 'browser-desktop: HTTP and WebSocket routes')
}
