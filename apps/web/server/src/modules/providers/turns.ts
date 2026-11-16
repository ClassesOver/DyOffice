/** Not mounted: production wiring requires T12 authority, secrets and budget admission. */
export interface TurnIdentity { deploymentId: string; userId: string; sessionId: string }
export interface TurnPermit { identity: TurnIdentity; revision: string }
export interface TurnRequest { system: string; messages: unknown[]; tools: unknown[] }
export type TurnEvent = { type: 'delta' | 'reasoning'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number }
  | { type: 'stop_reason'; reason: string }
export interface TurnDependencies<P extends TurnPermit> {
  identity(token: string): Promise<TurnIdentity>
  /** Read-only permit lookup. No budget reservation: settlement is a future wiring gate. */
  authorize(token: string, modelId: string): Promise<P>
  revalidate(token: string, permit: P): Promise<void>
  stream(permit: P, request: TurnRequest, signal: AbortSignal): AsyncIterable<TurnEvent>
}
class TurnError extends Error {}
const fail = (message: string) => new TurnError(message)
const validId = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id)
function identityKey(identity: TurnIdentity) {
  if (!identity || ![identity.deploymentId,identity.userId,identity.sessionId].every(validId)) throw fail('AI turn unavailable')
  return JSON.stringify([identity.deploymentId,identity.userId,identity.sessionId])
}
function snapshot(value: unknown): TurnRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('Invalid AI request')
  const record = value as Record<string,unknown>
  if (Object.keys(record).some(key=>!['system','messages','tools'].includes(key)) || typeof record.system !== 'string' || !Array.isArray(record.messages) || !Array.isArray(record.tools)) throw fail('Invalid AI request')
  const json = JSON.stringify(record)
  if (new TextEncoder().encode(json).length > 1024 * 1024) throw fail('Invalid AI request')
  return JSON.parse(json) as TurnRequest
}
function normalize(event: TurnEvent): TurnEvent {
  if (!event || typeof event !== 'object') throw fail('AI turn unavailable')
  let clean: TurnEvent
  if ((event.type === 'delta' || event.type === 'reasoning') && typeof event.text === 'string') clean = {type:event.type,text:event.text}
  else if (event.type === 'tool_call' && validId(event.id) && validId(event.name) && event.input && typeof event.input === 'object' && !Array.isArray(event.input)) clean = {type:event.type,id:event.id,name:event.name,input:event.input}
  else if (event.type === 'stop_reason' && typeof event.reason === 'string') clean = {type:event.type,reason:event.reason}
  else if (event.type === 'usage' && [event.inputTokens,event.outputTokens].every(n=>n===undefined || Number.isSafeInteger(n) && n>=0)) clean = {type:'usage',...(event.inputTokens===undefined?{}:{inputTokens:event.inputTokens}),...(event.outputTokens===undefined?{}:{outputTokens:event.outputTokens})}
  else throw fail('AI turn unavailable')
  const json = JSON.stringify(clean)
  if (new TextEncoder().encode(json).length > 256 * 1024) throw fail('AI turn unavailable')
  return JSON.parse(json) as TurnEvent
}
export function createProviderTurns<P extends TurnPermit>(deps: TurnDependencies<P>, {timeoutMs = 120_000,maxActive = 16,maxOutputBytes = 4 * 1024 * 1024}: {timeoutMs?: number;maxActive?: number;maxOutputBytes?: number} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647 || !Number.isSafeInteger(maxActive) || maxActive < 1 || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) throw new Error('Invalid AI turn limits')
  const all = new Set<AbortController>()
  const active = new Map<string,AbortController>()
  return {
    activeCount: () => all.size,
    async run(input: {token:string;modelId:string;turnId:string;request:unknown}, emit:(event:TurnEvent)=>void|Promise<void>) {
      if (!validId(input.turnId) || !validId(input.modelId) || typeof input.token !== 'string') throw fail('Invalid AI request')
      const {token,modelId,turnId} = input
      const request = snapshot(input.request)
      if (all.size >= maxActive) throw fail('AI turn capacity reached')
      const pending = new Set<Promise<unknown>>()
      const controller = new AbortController()
      all.add(controller)
      let key: string | undefined
      let abort!: () => void
      const stopped = new Promise<never>((_resolve,reject)=>{abort=()=>reject(controller.signal.reason);controller.signal.addEventListener('abort',abort,{once:true})})
      const deadline = setTimeout(()=>controller.abort(fail('AI turn timed out')),timeoutMs)
      const step = <T>(operation:()=>Promise<T>):Promise<T> => {
        if (controller.signal.aborted) return Promise.reject(controller.signal.reason)
        const work = Promise.resolve().then(()=>{
          if (controller.signal.aborted) throw controller.signal.reason
          return operation()
        })
        pending.add(work)
        void work.then(()=>pending.delete(work),()=>pending.delete(work))
        return Promise.race([work,stopped])
      }
      let iterator: AsyncIterator<TurnEvent> | undefined
      let outputBytes = 0
      try {
        const identity = await step(()=>deps.identity(token))
        key = identityKey(identity) + ':' + turnId
        if (active.has(key)) throw fail('AI turn already active')
        active.set(key,controller)
        const permit = await step(()=>deps.authorize(token,modelId))
        if (identityKey(permit.identity) !== identityKey(identity) || !permit.revision) throw fail('AI turn unavailable')
        await step(()=>deps.revalidate(token,permit))
        iterator = deps.stream(permit,request,controller.signal)[Symbol.asyncIterator]()
        for (;;) {
          const result = await step(()=>iterator!.next())
          if (result.done) break
          const event = normalize(result.value)
          // Budget normalized JSON payload bytes, not UTF-16 code units.
          const eventBytes = new TextEncoder().encode(JSON.stringify(event)).byteLength
          if (eventBytes > maxOutputBytes - outputBytes) throw fail('AI turn output limit exceeded')
          outputBytes += eventBytes
          await step(()=>deps.revalidate(token,permit))
          await step(async()=>{await emit(event)})
        }
      } catch (error) {
        throw error instanceof TurnError ? error : fail('AI turn unavailable')
      } finally {
        clearTimeout(deadline)
        controller.signal.removeEventListener('abort',abort)
        controller.abort()
        if (key && active.get(key)===controller) active.delete(key)
        // Do not await an uncooperative provider's cleanup after the deadline.
        try {
          const cleanup = iterator?.return?.()
          if (cleanup) { pending.add(cleanup); void cleanup.catch(()=>{}) }
        } catch { /* best effort */ }
        // Keep capacity reserved for dependencies that ignore cancellation. This
        // fails closed instead of admitting unlimited orphan model requests.
        if (pending.size) void Promise.allSettled([...pending]).then(()=>all.delete(controller))
        else all.delete(controller)
      }
    },
    async cancel(token:string,turnId:string) {
      if (!validId(turnId)) return false
      const identity = await deps.identity(token)
      const controller = active.get(identityKey(identity)+':'+turnId)
      if (!controller) return false
      controller.abort(fail('AI turn cancelled'))
      return true
    },
  }
}
