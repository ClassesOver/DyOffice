import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { PrincipalTransactions } from '../../db/context.ts'
import type { SessionService } from '../auth/sessions.ts'
import { authError } from '../auth/sessions.ts'
import { cookies, type createCsrfService } from '../auth/csrf.ts'
import { createProviderTurns, type TurnIdentity } from './turns.ts'

/** Local diagnostic only: no provider imports, config/secret reads, budget grants,
 * request content, external I/O, or tool execution. Not provider acceptance. */
export function registerAdminSyntheticProbe(app: FastifyInstance, {
  transactions, sessions, csrf,
}: {
  transactions: PrincipalTransactions
  sessions: Pick<SessionService, 'authenticate'>
  csrf: Pick<ReturnType<typeof createCsrfService>, 'requireSession'>
}) {
  let disposed = false
  async function identity(token: string): Promise<TurnIdentity> {
    if (disposed) throw authError(403)
    return transactions.withPrincipalTransaction({ kind: 'session', token }, async (_c, p) => {
      if (disposed || !p.roles.includes('config_admin')) throw authError(403)
      return { deploymentId: p.deploymentId, userId: p.userId, sessionId: p.sessionId }
    })
  }
  const turns = createProviderTurns({
    async identity(token) { await sessions.authenticate(token); return identity(token) },
    async authorize(token) { return { identity: await identity(token), revision: 'synthetic-v1' } },
    async revalidate(token, permit) {
      if (JSON.stringify(await identity(token)) !== JSON.stringify(permit.identity)) throw authError(403)
    },
    async *stream() { yield { type: 'delta' as const, text: 'synthetic' } },
  }, { timeoutMs: 5000, maxActive: 1, maxOutputBytes: 128 })
  const dispose = () => { disposed = true; turns.dispose() }
  app.addHook('preClose', async () => { dispose() })
  app.addHook('onClose', async () => { dispose() })
  app.post('/api/v1/admin/ai/synthetic-probe', {
    bodyLimit: 128,
    schema: {
      body: { type: 'object', additionalProperties: false, maxProperties: 0 },
      querystring: { type: 'object', additionalProperties: false, maxProperties: 0 },
    },
    onRequest: async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store')
      csrf.requireSession(request, cookies(request).session)
    },
  }, async (request, reply) => {
    const controller = new AbortController()
    const disconnect = () => controller.abort()
    reply.raw.on('close', disconnect)
    try {
      await turns.run({ token: cookies(request).session ?? '', modelId: 'synthetic', turnId: randomUUID(),
        request: { system: '', messages: [], tools: [] }, signal: controller.signal }, async () => {})
      return { mode: 'synthetic', result: 'ok', externalRequests: 0, credentialsRead: false, billable: false }
    } catch { throw authError(403) }
    finally { reply.raw.off('close', disconnect) }
  })
  return {dispose,async drain({timeoutMs=35_000}:{timeoutMs?:number}={}){
    if(!disposed||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>35_000)throw new Error('Synthetic probe drain unavailable')
    const deadline=performance.now()+timeoutMs
    while(turns.pendingCount()){
      if(performance.now()>=deadline)throw new Error('Synthetic probe drain timed out')
      await new Promise(resolve=>setTimeout(resolve,Math.min(10,Math.max(1,deadline-performance.now()))))
    }
  }}
}
