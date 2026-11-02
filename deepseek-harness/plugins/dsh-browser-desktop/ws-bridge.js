// WebSocket <-> TCP bridge and WebSocket frame codec for the VNC desktop.
//
// The desktop has no TCP port of its own on any interface a browser can use:
// this module speaks the WebSocket server side on the path DSH already exposes
// and pipes the decoded RFB bytes to x11vnc on loopback. That keeps the desktop
// behind the same origin, the same TLS terminator, the same authenticating
// proxy and the same Host allowlist as the rest of the UI, instead of adding a
// second port (or host) that would need its own policy.
//
// Only what noVNC needs is implemented: server-side upgrade, binary messages,
// fragmentation, ping/pong, close handshake and backpressure. No extension is
// negotiated, so permessage-deflate never enters the picture.
import crypto from 'node:crypto'
import net from 'node:net'

const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

export const MAX_MESSAGE_BYTES = 16 * 1024 * 1024

export const OPCODE = Object.freeze({
  continuation: 0x0,
  text: 0x1,
  binary: 0x2,
  close: 0x8,
  ping: 0x9,
  pong: 0xa,
})

/** RFC 6455 §4.2.2 accept token for a client Sec-WebSocket-Key. */
export function acceptKey(key) {
  return crypto.createHash('sha1').update(`${key}${WEBSOCKET_GUID}`).digest('base64')
}

function encodeLength(length) {
  if (length < 126) return Buffer.from([length])
  if (length < 65536) {
    const header = Buffer.alloc(3)
    header[0] = 126
    header.writeUInt16BE(length, 1)
    return header
  }
  const header = Buffer.alloc(9)
  header[0] = 127
  header.writeBigUInt64BE(BigInt(length), 1)
  return header
}

/** One unmasked server-to-client frame. */
export function encodeFrame(opcode, payload = Buffer.alloc(0)) {
  return Buffer.concat([Buffer.from([0x80 | opcode]), encodeLength(payload.length), payload])
}

export function encodeClose(code, reason = '') {
  const text = Buffer.from(reason, 'utf8').subarray(0, 123)
  const payload = Buffer.alloc(2 + text.length)
  payload.writeUInt16BE(code, 0)
  text.copy(payload, 2)
  return encodeFrame(OPCODE.close, payload)
}

/** Codes a closing endpoint may echo back (RFC 6455 §7.4). */
export function replyCloseCode(code) {
  if (!Number.isInteger(code) || code < 1000 || code > 4999) return 1000
  if ([1004, 1005, 1006, 1015].includes(code)) return 1000
  return code
}

export function maskPayload(payload, key) {
  for (let index = 0; index < payload.length; index += 1) payload[index] ^= key[index & 3]
  return payload
}

/**
 * Incremental parser for client-to-server frames. The browser must mask every
 * frame; anything else is a protocol error (RFC 6455 §5.1) and the caller sends
 * a close frame instead of guessing.
 */
export class FrameParser {
  #pending = Buffer.alloc(0)
  #fragments = null
  #fragmentBytes = 0
  #dead = false

  constructor({ onMessage, onPing = () => {}, onPong = () => {}, onClose = () => {}, onError = () => {} }) {
    this.onMessage = onMessage
    this.onPing = onPing
    this.onPong = onPong
    this.onClose = onClose
    this.onError = onError
  }

  get dead() {
    return this.#dead
  }

  push(chunk) {
    if (this.#dead || chunk.length === 0) return
    this.#pending = this.#pending.length === 0 ? chunk : Buffer.concat([this.#pending, chunk])
    while (!this.#dead && this.#parseOne()) { /* keep consuming */ }
  }

  #fail(code, reason) {
    this.#dead = true
    this.#pending = Buffer.alloc(0)
    this.#fragments = null
    this.onError(code, reason)
    return false
  }

  #parseOne() {
    const buffer = this.#pending
    if (buffer.length < 2) return false

    const fin = (buffer[0] & 0x80) !== 0
    const opcode = buffer[0] & 0x0f
    const control = (opcode & 0x08) !== 0
    if ((buffer[0] & 0x70) !== 0) return this.#fail(1002, 'reserved bits must be zero')
    if (!control && ![OPCODE.continuation, OPCODE.text, OPCODE.binary].includes(opcode)) {
      return this.#fail(1002, 'unknown opcode')
    }
    if (control && ![OPCODE.close, OPCODE.ping, OPCODE.pong].includes(opcode)) {
      return this.#fail(1002, 'unknown control opcode')
    }
    if ((buffer[1] & 0x80) === 0) return this.#fail(1002, 'client frames must be masked')

    let length = buffer[1] & 0x7f
    let offset = 2
    if (length === 126) {
      if (buffer.length < 4) return false
      length = buffer.readUInt16BE(2)
      offset = 4
    } else if (length === 127) {
      if (buffer.length < 10) return false
      const wide = buffer.readBigUInt64BE(2)
      if (wide > BigInt(MAX_MESSAGE_BYTES)) return this.#fail(1009, 'message too large')
      length = Number(wide)
      offset = 10
    }
    if (control && (length > 125 || !fin)) return this.#fail(1002, 'control frames must be final and short')
    if (length > MAX_MESSAGE_BYTES) return this.#fail(1009, 'message too large')
    if (buffer.length < offset + 4 + length) return false

    const payload = maskPayload(Buffer.from(buffer.subarray(offset + 4, offset + 4 + length)), buffer.subarray(offset, offset + 4))
    this.#pending = buffer.subarray(offset + 4 + length)
    this.#dispatch(fin, opcode, payload)
    return true
  }

  #dispatch(fin, opcode, payload) {
    if (opcode === OPCODE.close) {
      this.#dead = true
      this.onClose(payload)
      return
    }
    if (opcode === OPCODE.ping) {
      this.onPing(payload)
      return
    }
    if (opcode === OPCODE.pong) {
      this.onPong(payload)
      return
    }
    if (opcode === OPCODE.text) {
      this.#fail(1003, 'text frames are not supported')
      return
    }
    if (opcode === OPCODE.continuation) {
      if (this.#fragments === null) {
        this.#fail(1002, 'continuation without a started message')
        return
      }
      this.#fragments.push(payload)
      this.#fragmentBytes += payload.length
      if (this.#fragmentBytes > MAX_MESSAGE_BYTES) {
        this.#fail(1009, 'message too large')
        return
      }
      if (fin) {
        const message = Buffer.concat(this.#fragments)
        this.#fragments = null
        this.#fragmentBytes = 0
        this.onMessage(message)
      }
      return
    }
    // binary
    if (fin) {
      this.onMessage(payload)
      return
    }
    this.#fragments = [payload]
    this.#fragmentBytes = payload.length
  }
}

/**
 * Validate an HTTP upgrade and answer it with 101. Returns false when the
 * request is not an acceptable WebSocket handshake, after answering 400.
 */
export function acceptUpgrade(request, socket, logger = () => {}) {
  const key = request.headers['sec-websocket-key']
  const version = request.headers['sec-websocket-version']
  const protocols = String(request.headers['sec-websocket-protocol'] ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  if (request.headers.upgrade?.toLowerCase() !== 'websocket' || typeof key !== 'string' || key.trim() === '') {
    logger('rejected an upgrade without a WebSocket handshake')
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    return false
  }
  if (version !== undefined && String(version).trim() !== '13') {
    logger(`rejected WebSocket version ${String(version)}`)
    socket.end('HTTP/1.1 426 Upgrade Required\r\nSec-WebSocket-Version: 13\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    return false
  }
  // noVNC sends no subprotocol by default; a client that demands one may only
  // get "binary" here, because base64 framing is not implemented.
  if (protocols.length > 0 && !protocols.includes('binary')) {
    logger(`rejected subprotocol ${protocols.join(',')}`)
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    return false
  }
  const lines = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey(key.trim())}`,
  ]
  if (protocols.includes('binary')) lines.push('Sec-WebSocket-Protocol: binary')
  socket.write(`${lines.join('\r\n')}\r\n\r\n`)
  return true
}

/**
 * Pipe one accepted WebSocket connection to a loopback TCP service.
 *
 * @param {object} options
 * @param {import('node:net').Socket} options.socket upgraded socket owned here
 * @param {Buffer} [options.head] bytes the HTTP parser already consumed
 * @param {string} [options.host] loopback target address
 * @param {number} options.port loopback target port
 * @param {number} [options.pingIntervalMs] keep-alive ping interval
 * @param {(message: string) => void} [options.logger]
 * @param {typeof net.connect} [options.connect] injectable for tests
 * @returns {{ close: () => void, stats: () => { up: number, down: number, connected: boolean } }}
 */
export function bridgeToTcp({
  socket,
  head,
  host = '127.0.0.1',
  port,
  pingIntervalMs = 30_000,
  logger = () => {},
  connect = net.connect,
}) {
  let closed = false
  let up = 0
  let down = 0
  let connected = false
  let socketEnded = false
  let timer

  const tcp = connect({ host, port })
  tcp.setNoDelay(true)
  socket.setNoDelay?.(true)

  const cleanup = () => {
    if (closed) return
    closed = true
    clearInterval(timer)
    tcp.destroy()
    if (socketEnded) {
      // Let a just-written close frame flush before the socket goes away.
      if (typeof socket.destroySoon === 'function') socket.destroySoon()
      else socket.destroy?.()
      return
    }
    socket.destroy?.()
  }

  const endSocket = (code, reason) => {
    if (socketEnded) return
    socketEnded = true
    try {
      socket.end(encodeClose(code, reason))
    } catch {
      socket.destroy?.()
    }
  }

  // Protocol errors are safe to echo (they describe the client's own frame);
  // loopback transport errors are not, so the close reason stays generic and
  // the detail only reaches the container log.
  const fail = (code, detail, reason = detail) => {
    logger(`closing the desktop stream: ${detail}`)
    endSocket(code, reason)
    cleanup()
  }

  const parser = new FrameParser({
    onMessage: (payload) => {
      up += payload.length
      if (!tcp.write(payload)) socket.pause?.()
    },
    onPing: (payload) => { socket.write(encodeFrame(OPCODE.pong, payload)) },
    onClose: (payload) => {
      endSocket(replyCloseCode(payload.length >= 2 ? payload.readUInt16BE(0) : 1005))
      cleanup()
    },
    onError: fail,
  })

  tcp.on('connect', () => {
    connected = true
    logger(`desktop stream attached to ${host}:${port}`)
    if (head?.length) parser.push(head)
  })
  tcp.on('data', (chunk) => {
    down += chunk.length
    if (!socket.write(encodeFrame(OPCODE.binary, chunk))) tcp.pause()
  })
  tcp.on('drain', () => socket.resume?.())
  tcp.on('error', (error) => {
    fail(1011, `desktop unavailable: ${error.code ?? error.message}`, 'desktop unavailable')
  })
  tcp.on('close', () => {
    if (closed) return
    // The desktop closed first; tell the browser rather than letting the panel
    // sit on a dead socket.
    endSocket(1000, 'desktop closed')
    cleanup()
  })

  // Anything the client sends before the loopback connect completes is queued
  // on the TCP socket by Node, so the parser can start immediately.
  socket.on('data', (chunk) => parser.push(chunk))
  socket.on('drain', () => tcp.resume())
  socket.on('error', () => cleanup())
  socket.on('close', () => {
    if (closed) return
    closed = true
    clearInterval(timer)
    tcp.destroy()
  })

  timer = setInterval(() => {
    if (socketEnded) return
    // Traefik, Authentik's outpost and corporate load balancers all drop idle
    // connections eventually; a ping keeps the RFB stream alive without data.
    socket.write(encodeFrame(OPCODE.ping))
  }, pingIntervalMs)
  timer.unref?.()

  return {
    close: cleanup,
    stats: () => ({ up, down, connected }),
  }
}
