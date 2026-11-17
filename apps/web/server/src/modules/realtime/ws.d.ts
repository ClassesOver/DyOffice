// Minimal structural declarations for the pinned 'ws' package (server-side
// only; the browser editor bridge uses the native WebSocket API instead of
// importing 'ws'). Only the surface the realtime gateway touches is declared.
declare module 'ws' {
  type RawData = Buffer | ArrayBuffer | Buffer[]
  class WebSocketBase {
    on(event: 'message', listener: (data: RawData, isBinary: boolean) => void): this
    on(event: 'close', listener: (code: number, reason: Buffer) => void): this
    on(event: 'pong', listener: (data: Buffer) => void): this
    on(event: 'error', listener: (error: Error) => void): this
    on(event: string, listener: (...args: unknown[]) => void): this
    once(event: string, listener: (...args: unknown[]) => void): this
    readyState: 0 | 1 | 2 | 3
    readonly bufferedAmount: number
    send(data: string, callback?: (error?: Error) => void): void
    ping(data?: string): void
    close(code?: number, reason?: string): void
    terminate(): void
  }
  export class WebSocket extends WebSocketBase {
    static readonly CONNECTING: 0
    static readonly OPEN: 1
    static readonly CLOSING: 2
    static readonly CLOSED: 3
  }
  export class WebSocketServer {
    constructor(options: { noServer?: boolean; maxPayload?: number })
    handleUpgrade(request: import('node:http').IncomingMessage, socket: import('node:stream').Duplex, head: Buffer, callback: (socket: WebSocket) => void): void
    close(callback?: (error?: Error) => void): void
  }
  export default WebSocket
}
