import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { authError } from '../auth/sessions.ts'

// Route groups installed on the same application share the object-I/O budget.
// Keep it outside plugin encapsulation, without sharing capacity across apps.
const applications = new WeakMap<FastifyInstance, ReturnType<typeof createAdmission>>()
function createAdmission() {
  let active = 0
  const admitted = new WeakMap<FastifyRequest, { running: boolean; closed: boolean }>()
  function release(request: FastifyRequest) { if (admitted.delete(request)) active-- }
  function close(request: FastifyRequest) {
    const state = admitted.get(request)
    if (state) { state.closed = true; if (!state.running) release(request) }
  }
  return {
    // Call only after authentication/CSRF checks, before body parsing or I/O.
    admit(request: FastifyRequest, reply: FastifyReply) {
      if (admitted.has(request)) return
      if (request.raw.aborted || reply.raw.destroyed) throw authError(400)
      if (active >= 2) throw Object.assign(authError(503), { retryAfter: 1 })
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
