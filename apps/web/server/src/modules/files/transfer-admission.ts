import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { authError } from '../auth/sessions.ts'

// Route groups installed on the same application share the object-I/O budget.
// Keep it outside plugin encapsulation, without sharing capacity across apps.
const applications = new WeakMap<FastifyInstance, ReturnType<typeof createAdmission>>()
const CAPACITY = 2
const MAX_WAITERS = 4

interface Waiter {
  request: FastifyRequest
  reply: FastifyReply
  settle: (granted: boolean) => void
  timer: NodeJS.Timeout
  onAbort: () => void
}

function createAdmission() {
  let active = 0
  const admitted = new WeakMap<FastifyRequest, { running: boolean; closed: boolean }>()
  const waiters: Waiter[] = []
  function release(request: FastifyRequest) {
    if (!admitted.delete(request)) return
    active--
    // Hand the freed slot straight to the oldest queued save so a bounded-wait
    // writer cannot be overtaken by a fresh request between wake and check.
    const waiter = waiters.shift()
    if (!waiter) return
    clearTimeout(waiter.timer)
    waiter.request.raw.removeListener('aborted', waiter.onAbort)
    waiter.reply.raw.removeListener('close', waiter.onAbort)
    active++
    admitted.set(waiter.request, { running: false, closed: false })
    waiter.request.raw.once('aborted', () => close(waiter.request))
    waiter.reply.raw.once('close', () => close(waiter.request))
    waiter.settle(true)
  }
  function close(request: FastifyRequest) {
    const state = admitted.get(request)
    if (state) { state.closed = true; if (!state.running) release(request) }
  }
  return {
    // Call only after authentication/CSRF checks, before body parsing or I/O.
    // Callers that pass waitMs (saves) queue for a bounded wait when the
    // budget is busy instead of starving behind concurrent reads; reads still
    // get the immediate 503 that caps peak object streams at CAPACITY. The
    // returned promise MUST be awaited by the onRequest hook, or the request
    // would reach its handler before a slot exists.
    admit(request: FastifyRequest, reply: FastifyReply, options?: { waitMs?: number }): void | Promise<void> {
      if (admitted.has(request)) return
      if (request.raw.aborted || reply.raw.destroyed) throw authError(400)
      if (active >= CAPACITY) {
        if (!options?.waitMs) throw Object.assign(authError(503), { retryAfter: 1 })
        if (waiters.length >= MAX_WAITERS) throw Object.assign(authError(503), { retryAfter: 1 })
        const waiter: Waiter = { request, reply, settle: () => {}, timer: undefined as unknown as NodeJS.Timeout, onAbort: () => {} }
        const granted = new Promise<boolean>(resolve => { waiter.settle = resolve })
        waiter.onAbort = () => {
          const index = waiters.indexOf(waiter)
          if (index >= 0) {
            waiters.splice(index, 1)
            clearTimeout(waiter.timer)
            request.raw.removeListener('aborted', waiter.onAbort)
            reply.raw.removeListener('close', waiter.onAbort)
            waiter.settle(false)
          }
        }
        request.raw.once('aborted', waiter.onAbort)
        reply.raw.once('close', waiter.onAbort)
        waiter.timer = setTimeout(() => {
          const index = waiters.indexOf(waiter)
          if (index >= 0) {
            waiters.splice(index, 1)
            request.raw.removeListener('aborted', waiter.onAbort)
            reply.raw.removeListener('close', waiter.onAbort)
            waiter.settle(false)
          }
        }, options.waitMs)
        waiters.push(waiter)
        return granted.then(ok => {
          if (ok) return
          if (request.raw.aborted || reply.raw.destroyed) throw authError(400)
          throw Object.assign(authError(503), { retryAfter: 1 })
        })
      }
      active++; admitted.set(request, { running: false, closed: false })
      request.raw.once('aborted', () => close(request))
      reply.raw.once('close', () => close(request))
    },
    async transfer<T>(request: FastifyRequest, reply: FastifyReply, operation: () => Promise<T>): Promise<T> {
      const state = admitted.get(request)
      if (!state || state.closed || request.raw.aborted || reply.raw.destroyed) throw authError(400)
      state.running = true
      try { return await operation() }
      finally { state.running = false; if (state.closed) release(request) }
    },
    close,
    error(request: FastifyRequest) { if (!admitted.get(request)?.running) release(request) },
  }
}
export function objectTransferAdmission(app: FastifyInstance) {
  let budget = applications.get(app)
  if (!budget) { budget = createAdmission(); applications.set(app, budget) }
  return budget
}
