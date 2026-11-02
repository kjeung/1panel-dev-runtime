import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const pluginRoot = process.env.DSH_DESKTOP_PLUGIN_ROOT ?? '/opt/deepseek-harness/plugins/dsh-browser-desktop'

const paths = await import(join(pluginRoot, 'paths.js'))
const { createStaticHandler, contentType, entityTag } = await import(join(pluginRoot, 'static.js'))
const { FrameParser, acceptKey, acceptUpgrade, bridgeToTcp, encodeFrame, replyCloseCode } = await import(join(pluginRoot, 'ws-bridge.js'))

// ---------------------------------------------------------------------------
// Path geometry: every URL the panel embeds must stay on the Harness origin.
// ---------------------------------------------------------------------------

test('desktop paths stay absolute and same-origin', () => {
  assert.equal(paths.normalizeBasePath('/desktop/'), '/desktop')
  assert.equal(paths.normalizeBasePath(''), '/desktop')
  assert.throws(() => paths.normalizeBasePath('/'))
  assert.equal(paths.normalizePagePath('/vnc.html?autoconnect=1', '/vnc.html'), '/vnc.html?autoconnect=1')
  assert.throws(() => paths.normalizePagePath('https://other.example/vnc.html', '/vnc.html'))
  assert.throws(() => paths.normalizePagePath('//other.example/vnc.html', '/vnc.html'))
  assert.equal(paths.normalizeSocketPath('', '/desktop'), '/desktop/websockify')
  assert.throws(() => paths.normalizeSocketPath('/elsewhere/ws', '/desktop'))
  assert.throws(() => paths.normalizeSocketPath('/desktop/ws?token=1', '/desktop'))
})

test('the viewer URL pins the WebSocket path on the page origin', () => {
  const viewer = paths.viewerPath('/vnc.html?autoconnect=1&resize=scale', '/desktop/websockify', '/desktop')
  const url = new URL(viewer, 'https://dsh.example.com')
  assert.equal(url.origin, 'https://dsh.example.com')
  assert.equal(url.pathname, '/desktop/vnc.html')
  assert.equal(url.searchParams.get('path'), '/desktop/websockify')
  assert.equal(url.searchParams.get('autoconnect'), '1')
  // The mount point itself is not a page, and a protocol-relative URL is a
  // different origin rather than a path.
  assert.throws(() => paths.viewerPath('/', '/desktop/websockify', '/desktop'))
  assert.throws(() => paths.viewerPath('//other.example/vnc.html', '/desktop/websockify', '/desktop'))
})

// ---------------------------------------------------------------------------
// Static assets: no path escapes, no directory listings, cheap revalidation.
// ---------------------------------------------------------------------------

async function createAssetRoot() {
  const base = await mkdtemp(join(tmpdir(), 'dsh-desktop-'))
  const root = join(base, 'novnc')
  await mkdir(join(root, 'app'), { recursive: true })
  await writeFile(join(root, 'vnc.html'), '<!doctype html><title>noVNC</title>\n')
  await writeFile(join(root, 'app', 'ui.js'), 'export default 1\n')
  await writeFile(join(root, 'defaults.json'), '{}\n')
  await writeFile(join(base, 'secret.txt'), 'do not serve\n')
  await symlink(join(base, 'secret.txt'), join(root, 'escape.txt'))
  return { base, root, cleanup: () => rm(base, { recursive: true, force: true }) }
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}

async function startAssetServer(root) {
  const handler = createStaticHandler({ root, basePath: '/desktop' })
  const server = http.createServer((request, response) => {
    handler(request, response).catch((error) => {
      response.writeHead(500)
      response.end(String(error))
    })
  })
  const port = await listen(server)
  return { port, close: () => new Promise((resolve) => server.close(resolve)) }
}

function request(port, { method = 'GET', path = '/', headers = {} } = {}) {
  headers = { connection: 'close', ...headers }
  return new Promise((resolve, reject) => {
    const call = http.request({ host: '127.0.0.1', port, method, path, headers, agent: false }, (response) => {
      let body = ''
      response.on('data', (chunk) => { body += chunk })
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }))
    })
    call.on('error', reject)
    call.end()
  })
}

test('the desktop serves the noVNC viewer and its assets', async (t) => {
  const assets = await createAssetRoot()
  const server = await startAssetServer(assets.root)
  t.after(async () => { await server.close(); await assets.cleanup() })

  const viewer = await request(server.port, { path: '/desktop/vnc.html' })
  assert.equal(viewer.status, 200)
  assert.match(viewer.headers['content-type'], /^text\/html/)
  assert.equal(viewer.headers['x-content-type-options'], 'nosniff')
  assert.match(viewer.headers.etag, /^W\//)
  assert.equal(viewer.body, '<!doctype html><title>noVNC</title>\n')

  const module = await request(server.port, { path: '/desktop/app/ui.js' })
  assert.equal(module.status, 200)
  assert.match(module.headers['content-type'], /^text\/javascript/)

  const defaults = await request(server.port, { path: '/desktop/defaults.json' })
  assert.equal(defaults.status, 200)
  assert.match(defaults.headers['content-type'], /^application\/json/)

  const redirect = await request(server.port, { path: '/desktop/' })
  assert.equal(redirect.status, 302)
  assert.equal(redirect.headers.location, '/desktop/vnc.html')
})

test('the desktop refuses escapes, listings and unsupported methods', async (t) => {
  const assets = await createAssetRoot()
  const server = await startAssetServer(assets.root)
  t.after(async () => { await server.close(); await assets.cleanup() })

  for (const path of [
    '/desktop/../secret.txt',
    '/desktop/%2e%2e/secret.txt',
    '/desktop/escape.txt',
    '/desktop/app',
    '/elsewhere/vnc.html',
    '/desktop/missing.js',
  ]) {
    const response = await request(server.port, { path })
    assert.equal(response.status, 404, `expected 404 for ${path}`)
  }

  const method = await request(server.port, { method: 'POST', path: '/desktop/vnc.html' })
  assert.equal(method.status, 405)
  assert.equal(method.headers.allow, 'GET, HEAD')
})

test('the desktop answers HEAD and revalidates with its ETag', async (t) => {
  const assets = await createAssetRoot()
  const server = await startAssetServer(assets.root)
  t.after(async () => { await server.close(); await assets.cleanup() })

  const head = await request(server.port, { method: 'HEAD', path: '/desktop/vnc.html' })
  assert.equal(head.status, 200)
  assert.equal(head.body, '')
  assert.equal(Number(head.headers['content-length']), '<!doctype html><title>noVNC</title>\n'.length)

  const fresh = await request(server.port, {
    path: '/desktop/vnc.html',
    headers: { 'if-none-match': head.headers.etag },
  })
  assert.equal(fresh.status, 304)
  assert.equal(fresh.body, '')
})

test('asset content types and validators are stable', () => {
  assert.equal(contentType('a/b/rfb.js'), 'text/javascript; charset=utf-8')
  assert.equal(contentType('a/b/style.css'), 'text/css; charset=utf-8')
  assert.equal(contentType('a/b/logo.svg'), 'image/svg+xml')
  assert.equal(contentType('a/b/novnc.ico'), 'image/x-icon')
  assert.equal(contentType('a/b/unknown.bin'), 'application/octet-stream')
  const stats = { size: 256, mtimeMs: 1_700_000_000_000 }
  assert.equal(entityTag(stats), entityTag({ ...stats }))
  assert.notEqual(entityTag(stats), entityTag({ ...stats, size: 257 }))
})

// ---------------------------------------------------------------------------
// Frame codec: only what noVNC sends, but framed exactly.
// ---------------------------------------------------------------------------

function clientFrame(opcode, payload = Buffer.alloc(0), { fin = true, mask = true } = {}) {
  const body = Buffer.from(payload)
  const length = body.length
  let header
  if (length < 126) {
    header = Buffer.from([(fin ? 0x80 : 0) | opcode, (mask ? 0x80 : 0) | length])
  } else if (length < 65536) {
    header = Buffer.alloc(4)
    header[0] = (fin ? 0x80 : 0) | opcode
    header[1] = (mask ? 0x80 : 0) | 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = (fin ? 0x80 : 0) | opcode
    header[1] = (mask ? 0x80 : 0) | 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  if (!mask) return Buffer.concat([header, body])
  const key = Buffer.from([0x12, 0x34, 0x56, 0x78])
  const masked = Buffer.from(body)
  for (let index = 0; index < masked.length; index += 1) masked[index] ^= key[index & 3]
  return Buffer.concat([header, key, masked])
}

test('the accept token matches RFC 6455 and frames round-trip', () => {
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=')
  // Only codes a peer may echo are ever sent back.
  assert.equal(replyCloseCode(1000), 1000)
  assert.equal(replyCloseCode(1005), 1000)
  assert.equal(replyCloseCode(1011), 1011)
  assert.equal(replyCloseCode(42), 1000)

  const messages = []
  const errors = []
  const parser = new FrameParser({
    onMessage: (payload) => messages.push(payload.toString()),
    onError: (code, reason) => errors.push([code, reason]),
  })
  parser.push(clientFrame(0x2, Buffer.from('one')))
  // Fragmented binary message: the RFB client may split a paste across frames.
  parser.push(clientFrame(0x2, Buffer.from('tw'), { fin: false }))
  parser.push(clientFrame(0x0, Buffer.from('o'), { fin: true }))
  // A frame split across two TCP reads must still assemble.
  const split = clientFrame(0x2, Buffer.from('three'))
  parser.push(split.subarray(0, 3))
  parser.push(split.subarray(3))
  assert.deepEqual(messages, ['one', 'two', 'three'])
  assert.deepEqual(errors, [])
})

test('the frame parser rejects what a browser must never send', () => {
  const errors = []
  const parser = new FrameParser({
    onMessage: () => assert.fail('unexpected message'),
    onError: (code, reason) => errors.push([code, reason]),
  })
  parser.push(clientFrame(0x2, Buffer.from('x'), { mask: false }))
  assert.equal(errors.at(-1)[0], 1002)

  const text = new FrameParser({ onMessage: () => {}, onError: (code) => errors.push([code]) })
  text.push(clientFrame(0x1, Buffer.from('x')))
  assert.equal(errors.at(-1)[0], 1003)

  const fragmentedControl = new FrameParser({ onMessage: () => {}, onError: (code) => errors.push([code]) })
  fragmentedControl.push(clientFrame(0x9, Buffer.from('x'), { fin: false }))
  assert.equal(errors.at(-1)[0], 1002)
})

// ---------------------------------------------------------------------------
// Bridge: an upgraded socket becomes a transparent RFB byte pipe.
// ---------------------------------------------------------------------------

function createFrameReader(socket, initial = Buffer.alloc(0)) {
  const frames = []
  const waiters = []
  let buffer = initial

  function takeFrame() {
    if (buffer.length < 2) return null
    const opcode = buffer[0] & 0x0f
    let length = buffer[1] & 0x7f
    let offset = 2
    if (length === 126) {
      if (buffer.length < 4) return null
      length = buffer.readUInt16BE(2)
      offset = 4
    } else if (length === 127) {
      if (buffer.length < 10) return null
      length = Number(buffer.readBigUInt64BE(2))
      offset = 10
    }
    assert.equal(buffer[1] & 0x80, 0, 'the server must not mask frames')
    if (buffer.length < offset + length) return null
    const payload = Buffer.from(buffer.subarray(offset, offset + length))
    buffer = buffer.subarray(offset + length)
    return { opcode, payload }
  }

  function drain() {
    for (;;) {
      const frame = takeFrame()
      if (frame === null) break
      frames.push(frame)
    }
    while (waiters.length > 0 && frames.length > 0) waiters.shift()(frames.shift())
  }

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    drain()
  })
  drain()

  return {
    next({ timeoutMs = 5000 } = {}) {
      return new Promise((resolve, reject) => {
        if (frames.length > 0) {
          resolve(frames.shift())
          return
        }
        const timer = setTimeout(() => reject(new Error('timed out waiting for a WebSocket frame')), timeoutMs)
        waiters.push((frame) => {
          clearTimeout(timer)
          resolve(frame)
        })
      })
    },
  }
}

async function connectWebSocket(port, { path = '/desktop/websockify', protocols, version = '13' } = {}) {
  const socket = net.connect(port, '127.0.0.1')
  await once(socket, 'connect')
  const lines = [
    `GET ${path} HTTP/1.1`,
    'Host: desktop.test',
    'Upgrade: websocket',
    'Connection: Upgrade',
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
    `Sec-WebSocket-Version: ${version}`,
  ]
  if (protocols) lines.push(`Sec-WebSocket-Protocol: ${protocols}`)
  socket.write(`${lines.join('\r\n')}\r\n\r\n`)

  let head = Buffer.alloc(0)
  while (!head.includes('\r\n\r\n')) {
    const [chunk] = await once(socket, 'data')
    head = Buffer.concat([head, chunk])
  }
  const index = head.indexOf('\r\n\r\n')
  return {
    socket,
    head: head.subarray(0, index).toString('latin1'),
    reader: createFrameReader(socket, head.subarray(index + 4)),
  }
}

async function startEchoServer() {
  const sockets = new Set()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('data', (chunk) => socket.write(chunk))
  })
  const port = await listen(server)
  return {
    port,
    close: () => new Promise((resolve) => {
      for (const socket of sockets) socket.destroy()
      server.close(resolve)
    }),
  }
}

async function startBridgeServer(targetPort) {
  const sockets = new Set()
  const server = http.createServer((_request, response) => {
    response.writeHead(404)
    response.end()
  })
  server.on('upgrade', (request, socket, head) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    if (!acceptUpgrade(request, socket)) return
    bridgeToTcp({
      socket,
      head,
      host: '127.0.0.1',
      port: targetPort,
      pingIntervalMs: 60000,
    })
  })
  const port = await listen(server)
  return {
    port,
    close: () => new Promise((resolve) => {
      for (const socket of sockets) socket.destroy()
      server.close(resolve)
    }),
  }
}

test('the bridge answers the handshake and pipes RFB bytes both ways', async (t) => {
  const echo = await startEchoServer()
  const bridge = await startBridgeServer(echo.port)
  t.after(async () => { await bridge.close(); await echo.close() })

  const client = await connectWebSocket(bridge.port)
  t.after(() => client.socket.destroy())
  assert.match(client.head, /^HTTP\/1\.1 101 Switching Protocols/)
  assert.match(client.head, /Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=/)

  client.socket.write(clientFrame(0x2, Buffer.from('RFB 003.008\n')))
  const echoed = await client.reader.next()
  assert.equal(echoed.opcode, 0x2)
  assert.equal(echoed.payload.toString(), 'RFB 003.008\n')

  // Keep-alive: a browser answers the server's ping, and a client ping is
  // answered with the same payload.
  client.socket.write(clientFrame(0x9, Buffer.from('keepalive')))
  const pong = await client.reader.next()
  assert.equal(pong.opcode, 0xa)
  assert.equal(pong.payload.toString(), 'keepalive')

  // RFB is a byte stream: a large desktop update may come back as several
  // binary messages, but the reassembled bytes must match exactly.
  const large = Buffer.alloc(300_000, 0x41)
  client.socket.write(clientFrame(0x2, large))
  const parts = []
  let total = 0
  while (total < large.length) {
    const frame = await client.reader.next()
    assert.equal(frame.opcode, 0x2)
    parts.push(frame.payload)
    total += frame.payload.length
  }
  assert.ok(Buffer.concat(parts).equals(large))
})

test('the bridge closes with 1003 when a client sends text', async (t) => {
  const echo = await startEchoServer()
  const bridge = await startBridgeServer(echo.port)
  t.after(async () => { await bridge.close(); await echo.close() })

  const client = await connectWebSocket(bridge.port)
  t.after(() => client.socket.destroy())
  client.socket.write(clientFrame(0x1, Buffer.from('not binary')))
  const close = await client.reader.next()
  assert.equal(close.opcode, 0x8)
  assert.equal(close.payload.readUInt16BE(0), 1003)
})

test('the bridge reports an unavailable desktop instead of hanging', async (t) => {
  // Reserve a port, then close it: nothing listens there any more.
  const probe = net.createServer()
  const closedPort = await listen(probe)
  await new Promise((resolve) => probe.close(resolve))

  const bridge = await startBridgeServer(closedPort)
  t.after(() => bridge.close())

  const client = await connectWebSocket(bridge.port)
  t.after(() => client.socket.destroy())
  const close = await client.reader.next()
  assert.equal(close.opcode, 0x8)
  assert.equal(close.payload.readUInt16BE(0), 1011)
})

test('the upgrade route refuses non-WebSocket and base64-only clients', async (t) => {
  const echo = await startEchoServer()
  const bridge = await startBridgeServer(echo.port)
  t.after(async () => { await bridge.close(); await echo.close() })

  const rejected = await connectWebSocket(bridge.port, { protocols: 'base64' })
  t.after(() => rejected.socket.destroy())
  assert.match(rejected.head, /^HTTP\/1\.1 400/)

  const wrongVersion = await connectWebSocket(bridge.port, { version: '8' })
  t.after(() => wrongVersion.socket.destroy())
  assert.match(wrongVersion.head, /^HTTP\/1\.1 426/)

  // A client that offers "binary" gets it echoed back.
  const accepted = await connectWebSocket(bridge.port, { protocols: 'binary' })
  t.after(() => accepted.socket.destroy())
  assert.match(accepted.head, /^HTTP\/1\.1 101/)
  assert.match(accepted.head, /Sec-WebSocket-Protocol: binary/)
})

// ---------------------------------------------------------------------------
// Plugin wiring: the route table the Harness web server ends up with.
// ---------------------------------------------------------------------------

test('the plugin mounts the viewer, the socket and the tool routes', async (t) => {
  const assets = await createAssetRoot()
  t.after(() => assets.cleanup())

  const plugin = await import(join(pluginRoot, 'index.js'))
  const routes = []
  const disposers = []
  let effectCleanup = () => {}
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    systemPrompt: { section: () => {} },
    tools: { register: () => {} },
    webServer: {
      register(route) {
        routes.push({ kind: route.kind, path: route.path, handler: route.handler })
        return () => disposers.push(route.path)
      },
      registerUpgrade(route) {
        routes.push({ kind: 'upgrade', path: route.path, handler: route.handler })
        return () => disposers.push(route.path)
      },
    },
    effect(fn) {
      effectCleanup = fn()
      return () => {}
    },
  }

  plugin.apply(ctx, { novncRoot: assets.root })
  assert.deepEqual(routes.map((route) => [route.kind, route.path]), [
    ['exact', '/browser-desktop/state'],
    ['exact', '/browser-desktop/open'],
    ['prefix', '/desktop'],
    ['upgrade', '/desktop/websockify'],
  ])

  // The state route tells the panel where to point the iframe: same origin,
  // desktop prefix, socket path pinned.
  const state = routes[0]
  const response = await new Promise((resolve) => {
    const res = { statusCode: 0, body: '', headers: {}, writeHead(status) { this.statusCode = status }, end(body = '') { this.body = body; resolve(this) } }
    state.handler({ method: 'GET', headers: {} }, res)
  })
  assert.equal(response.statusCode, 200)
  const payload = JSON.parse(response.body)
  assert.equal(payload.desktop.path.startsWith('/desktop/vnc.html?'), true)
  assert.equal(new URL(payload.desktop.path, 'https://dsh.example.com').searchParams.get('path'), '/desktop/websockify')
  assert.equal(payload.pollIntervalMs, 750)

  // Disposal must release every route it claimed.
  effectCleanup()
  assert.equal(disposers.length, 4)
})

test('the server keeps frames unmasked and honours a split handshake', () => {
  const frame = encodeFrame(0x2, Buffer.from('abc'))
  assert.equal(frame[0], 0x82)
  assert.equal(frame[1] & 0x80, 0, 'server frames are never masked')
  assert.equal(frame[1] & 0x7f, 3)
  assert.equal(frame.subarray(2).toString(), 'abc')
})
