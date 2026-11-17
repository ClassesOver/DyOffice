import { Duplex } from 'node:stream'
import { createConnection, type Socket } from 'node:net'

interface Pin { address: string; port: number; family: 4 | 6 }
/** A transport facade shared by PG and MySQL drivers. It discards driver dial
 * arguments, connects only to a previously verified pin, and caps wire bytes
 * before a protocol parser can allocate an attacker-declared giant packet.
 * TLS remains end-to-end above this stream, with driver hostname verification.
 */
class BoundedSourceSocket extends Duplex {
  private socket?: Socket
  private received = 0
  constructor(private readonly pin: Pin, private readonly maxBytes: number) { super() }
  connect(..._ignored: unknown[]) {
    if (this.socket) return this
    const socket = createConnection({ host: this.pin.address, port: this.pin.port, family: this.pin.family })
    this.socket = socket
    socket.on('connect', () => this.emit('connect'))
    socket.on('data', (chunk: Buffer) => {
      this.received += chunk.length
      if (this.received > this.maxBytes) { this.destroy(new Error('Source response limit exceeded')); return }
      if (!this.push(chunk)) socket.pause()
    })
    socket.on('end', () => this.push(null))
    socket.on('error', error => this.destroy(error))
    socket.on('close', () => { if (!this.destroyed) this.destroy() })
    return this
  }
  setNoDelay(enable = true) { this.socket?.setNoDelay(enable); return this }
  setKeepAlive(enable = false, delay = 0) { this.socket?.setKeepAlive(enable, delay); return this }
  setTimeout(ms: number, callback?: () => void) { this.socket?.setTimeout(ms, callback); return this }
  _read() { this.socket?.resume() }
  _write(chunk: Buffer, encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    if (!this.socket || this.socket.destroyed) { callback(new Error('Source connection unavailable')); return }
    this.socket.write(chunk, encoding, callback)
  }
  _final(callback: (error?: Error | null) => void) { this.socket?.end(); callback() }
  _destroy(error: Error | null, callback: (error?: Error | null) => void) { this.socket?.destroy(); callback(error) }
}
export function createBoundedSourceSocket(pin: Pin, maxBytes: number) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16_000_000) throw new Error('Invalid source wire limit')
  return new BoundedSourceSocket(Object.freeze({ ...pin }), maxBytes)
}
