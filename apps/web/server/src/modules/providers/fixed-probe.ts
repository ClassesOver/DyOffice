import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { SessionService } from '../auth/sessions.ts'
import { authError } from '../auth/sessions.ts'
import { createAdminProviderPipeline } from './admin-pipeline.ts'
import { createProviderTurns } from './turns.ts'
import { registerFixedProviderProbeRoutes } from './fixed-probe-routes.ts'

/** Explicit fixed-prompt probe. Unlike the offline diagnostic this CAN send to a
 * real provider when supplied real profiles/credentials/budget. No automatic run. */
export function registerFixedProviderProbe(app: FastifyInstance, config:
  Parameters<typeof createAdminProviderPipeline>[0] & {
    deploymentId: string
    sessions: Pick<SessionService,'authenticate'>
    csrf: Parameters<typeof registerFixedProviderProbeRoutes>[1]['csrf']
  }) {
  if (!Array.isArray(config.profiles) || !config.profiles.length
    || config.profiles.some(p => !p || p.deploymentId !== config.deploymentId)
    || new Set(config.profiles.map(p => p.entryId)).size !== config.profiles.length) throw new Error('Invalid provider probe configuration')
  const pipeline = createAdminProviderPipeline(config)
  let disposed = false
  async function identity(token: string) {
    if (disposed) throw authError(403)
    const p = await config.sessions.authenticate(token)
    if (disposed || p.deploymentId !== config.deploymentId || !p.roles.includes('config_admin')) throw authError(403)
    return {deploymentId:p.deploymentId,userId:p.userId,sessionId:p.sessionId}
  }
  // Track actual authentication promises even when their HTTP waiter stops.
  const admission = createProviderTurns({ identity,
    authorize: async token => ({identity:await identity(token),revision:'fixed-probe-v1'}),
    async revalidate(token,permit) { if(JSON.stringify(await identity(token))!==JSON.stringify(permit.identity))throw authError(403) },
    async *stream() {},
  },{timeoutMs:5000,maxActive:1})
  const dispose = () => { disposed=true;admission.dispose();pipeline.dispose() }
  const drain = async ({timeoutMs=35_000}:{timeoutMs?:number}={}) => {
    if(!disposed || !Number.isSafeInteger(timeoutMs) || timeoutMs<1 || timeoutMs>35_000)throw new Error('Provider probe drain unavailable')
    const deadline=performance.now()+timeoutMs
    await Promise.all([pipeline.drain({timeoutMs}), (async()=>{
      while(admission.pendingCount()){
        if(performance.now()>=deadline)throw new Error('Provider probe drain timed out')
        await new Promise(resolve=>setTimeout(resolve,Math.min(10,Math.max(1,deadline-performance.now()))))
      }
    })()])
  }
  try {
    app.addHook('preClose',async()=>{dispose()})
    registerFixedProviderProbeRoutes(app,{pipeline,csrf:config.csrf,authorize:async token=>{
      try { await admission.run({token,modelId:'fixed-probe',turnId:randomUUID(),request:{system:'',messages:[],tools:[]}},async()=>{}) }
      catch { throw authError(403) }
    }})
  } catch (error) {dispose();throw error}
  return {dispose,drain}
}
