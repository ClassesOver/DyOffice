import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import type { FastifyReply } from 'fastify'

type Page = { events: readonly { sequence: number }[]; state?: string }
const terminal = new Set(['succeeded', 'failed', 'unknown_outcome', 'cancelled'])

/** Each page read must recheck the caller's access, including after reconnect. */
export async function streamTaskEvents(reply: FastifyReply, after: number, read: (cursor: number) => Promise<Page>) {
  let page = await read(after)
  const response = reply.raw
  const closed = new AbortController()
  if (response.destroyed) return
  response.once('close', () => closed.abort())
  reply.hijack()
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'private, no-store',
    'X-Accel-Buffering': 'no',
  })
  response.flushHeaders()
  const deadline = Date.now() + 120_000
  const timeout = setTimeout(() => closed.abort(), 120_000)
  let lastWrite = Date.now()
  async function send(frame: string) {
    closed.signal.throwIfAborted()
    if (!response.write(frame)) await once(response, 'drain', { signal: closed.signal })
    lastWrite = Date.now()
  }
  try {
    while (!closed.signal.aborted) {
      for (const event of page.events) {
        await send(`id: ${event.sequence}\nevent: task\ndata: ${JSON.stringify(event)}\n\n`)
        after = event.sequence
      }
      if (page.events.length < 256 && page.state && terminal.has(page.state)) {
        await send(`event: end\ndata: ${JSON.stringify({ state: page.state })}\n\n`)
        break
      }
      if (Date.now() >= deadline) break
      if (Date.now() - lastWrite >= 15_000) await send(': keep-alive\n\n')
      if (page.events.length < 256) await delay(500, undefined, { signal: closed.signal })
      page = await read(after)
    }
  } catch {
    // A disconnected or unauthorized reader must reconnect and authorize again.
  } finally {
    clearTimeout(timeout)
    response.end()
  }
}
