import type {CodingProgress} from '../../../../../../packages/agent-core/src/coding-skill.ts'
import {AI_TURN_TIMED_OUT,ASSISTANT_MAX_REQUEST_BYTES} from '../../../../../../packages/web-contracts/src/assistant.ts'
import {ProviderResponseFailure} from './response-failure.ts'
/** Not mounted: production wiring requires T12 authority, secrets and budget admission. */
export interface TurnIdentity { deploymentId: string; userId: string; sessionId: string }
export interface TurnPermit { identity: TurnIdentity; revision: string }
export interface TurnRequest { format?: 'docx'|'xlsx'|'pptx'|'pdf'; system: string; messages: unknown[]; tools: unknown[] }
export type TurnEvent = ({type:'progress'} & CodingProgress)
  | { type: 'delta' | 'reasoning'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: Record<string, unknown>; signature?:string }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number }
  | { type: 'stop_reason'; reason: string }
  | { type: 'error'; message: string; outcome?: 'failed' }
export interface TurnDependencies<P extends TurnPermit> {
  identity(token: string): Promise<TurnIdentity>
  /** Read-only permit lookup. No budget reservation: settlement is a future wiring gate. */
  authorize(token: string, modelId: string): Promise<P>
  revalidate(token: string, permit: P): Promise<void>
  stream(permit: P, request: TurnRequest, signal: AbortSignal, context: {token:string;turnId:string;timeoutMs:number;documentId?:string}): AsyncIterable<TurnEvent>
}
class TurnError extends Error {}
export class ProviderTurnTimeout extends TurnError {
  readonly code=AI_TURN_TIMED_OUT
  constructor(){super('AI turn timed out')}
}
const fail = (message: string) => new TurnError(message)
function logTurnFailure(turnId:string,stage:string,error:unknown) {
  const rawCode = error && typeof error === 'object' && 'code' in error ? (error as {code?:unknown}).code : undefined
  const code = typeof rawCode === 'string' && /^[A-Z0-9_-]{1,64}$/.test(rawCode)
    ? rawCode
    : error instanceof TurnError
      ? error.message.toUpperCase().replace(/[^A-Z0-9]+/g,'_').replace(/^_|_$/g,'')
      : 'UNCLASSIFIED'
  console.error('dyoffice: AI turn failed',{turnId,stage,code})
}
const validId = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id)
function identityKey(identity: TurnIdentity) {
  if (!identity || ![identity.deploymentId,identity.userId,identity.sessionId].every(validId)) throw fail('AI turn unavailable')
  return JSON.stringify([identity.deploymentId,identity.userId,identity.sessionId])
}
function snapshot(value: unknown): TurnRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('Invalid AI request')
  const record = value as Record<string,unknown>
  if (Object.keys(record).some(key=>!['format','system','messages','tools'].includes(key)) || (record.format!==undefined&&!['docx','xlsx','pptx','pdf'].includes(record.format as string)) || typeof record.system !== 'string' || !Array.isArray(record.messages) || !Array.isArray(record.tools)) throw fail('Invalid AI request')
  const json = JSON.stringify(record)
  if (new TextEncoder().encode(json).length > ASSISTANT_MAX_REQUEST_BYTES) throw fail('Invalid AI request')
  return JSON.parse(json) as TurnRequest
}
function normalize(event: TurnEvent): TurnEvent {
  if (!event || typeof event !== 'object') throw fail('AI turn unavailable')
  let clean: TurnEvent
  if ((event.type === 'delta' || event.type === 'reasoning') && typeof event.text === 'string') clean = {type:event.type,text:event.text}
  else if(event.type==='progress' && ['status','output'].includes(event.kind) && typeof event.text==='string') clean={type:'progress',kind:event.kind,text:event.text}
  else if (event.type === 'tool_call' && validId(event.id) && validId(event.name) && event.input && typeof event.input === 'object' && !Array.isArray(event.input)) clean = {type:event.type,id:event.id,name:event.name,input:event.input,...(typeof event.signature==='string'?{signature:event.signature}:{})}
  else if (event.type === 'stop_reason' && typeof event.reason === 'string') clean = {type:event.type,reason:event.reason}
  else if (event.type === 'error' && typeof event.message === 'string') clean = {type:event.type,message:event.message,...(event.outcome==='failed'?{outcome:event.outcome}:{})}
  else if (event.type === 'usage' && [event.inputTokens,event.outputTokens].every(n=>n===undefined || Number.isSafeInteger(n) && n>=0)) clean = {type:'usage',...(event.inputTokens===undefined?{}:{inputTokens:event.inputTokens}),...(event.outputTokens===undefined?{}:{outputTokens:event.outputTokens})}
  else throw fail('AI turn unavailable')
  const json = JSON.stringify(clean)
  if (new TextEncoder().encode(json).length > 256 * 1024) throw fail('AI turn unavailable')
  return JSON.parse(json) as TurnEvent
}
export function createProviderTurns<P extends TurnPermit>(deps: TurnDependencies<P>, {timeoutMs = 120_000,maxActive = 16,cancelTimeoutMs = 10_000,maxOutputBytes = 4 * 1024 * 1024}: {timeoutMs?: number|((request:TurnRequest)=>number);maxActive?: number;cancelTimeoutMs?: number;maxOutputBytes?: number} = {}) {
  const validTimeout=(value:number)=>Number.isSafeInteger(value)&&value>=1&&value<=2_147_483_647
  if ((typeof timeoutMs!=='function'&&!validTimeout(timeoutMs)) || !Number.isSafeInteger(maxActive) || maxActive < 1 || !validTimeout(cancelTimeoutMs) || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) throw new Error('Invalid AI turn limits')
  let disposed = false
  const cancellationStops = new Set<() => void>()
  const all = new Set<AbortController>()
  const active = new Map<string,AbortController>()
  const cancellationLookups = new Set<Promise<TurnIdentity>>()
  return {
    activeCount: () => all.size,
    pendingCount: () => all.size + cancellationLookups.size,
    dispose() {
      disposed = true
      for (const controller of all) controller.abort(fail('AI turn unavailable'))
      for (const stop of cancellationStops) stop()
    },
    async run(input: {token:string;modelId:string;turnId:string;request:unknown;signal?:AbortSignal;documentId?:string;admit?:(signal:AbortSignal)=>Promise<void>}, emit:(event:TurnEvent)=>void|Promise<void>) {
      if (disposed) throw fail('AI turn unavailable')
      if (!validId(input.turnId) || !validId(input.modelId) || typeof input.token !== 'string') throw fail('Invalid AI request')
      const {token,modelId,turnId} = input
      let request:TurnRequest
      try { request=snapshot(input.request) }
      catch(error) { logTurnFailure(turnId,'request_validation',error);throw error }
      const turnTimeout=typeof timeoutMs==='function'?timeoutMs(request):timeoutMs
      if(!validTimeout(turnTimeout))throw fail('Invalid AI turn limits')
      if (all.size >= maxActive) throw fail('AI turn capacity reached')
      const pending = new Set<Promise<unknown>>()
      const controller = new AbortController()
      all.add(controller)
      let key: string | undefined
      let abort!: () => void
      const stopped = new Promise<never>((_resolve,reject)=>{abort=()=>reject(controller.signal.reason);controller.signal.addEventListener('abort',abort,{once:true})})
      // A pre-aborted caller can stop before the first Promise.race attaches.
      void stopped.catch(()=>{})
      const disconnect = () => controller.abort(fail('AI turn cancelled'))
      input.signal?.addEventListener('abort',disconnect,{once:true})
      if (input.signal?.aborted) disconnect()
      const deadline = setTimeout(()=>controller.abort(new ProviderTurnTimeout()),turnTimeout)
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
      let stage = 'identity'
      try {
        const identity = await step(()=>deps.identity(token))
        key = identityKey(identity) + ':' + turnId
        if (active.has(key)) throw fail('AI turn already active')
        active.set(key,controller)
        stage = 'authorize'
        const permit = await step(()=>deps.authorize(token,modelId))
        if (identityKey(permit.identity) !== identityKey(identity) || !permit.revision) throw fail('AI turn unavailable')
        stage = 'revalidate'
        await step(()=>deps.revalidate(token,permit))
        if(input.admit){
          stage = 'admit_continuation'
          await step(()=>input.admit!(controller.signal))
        }
        stage = 'provider_stream'
        iterator = deps.stream(permit,request,controller.signal,{token,turnId,timeoutMs:turnTimeout,...(input.documentId?{documentId:input.documentId}:{})})[Symbol.asyncIterator]()
        for (;;) {
          stage = 'provider_stream'
          const result = await step(()=>iterator!.next())
          if (result.done) break
          stage = 'validate_event'
          const event = normalize(result.value)
          // Budget normalized JSON payload bytes, not UTF-16 code units.
          const eventBytes = new TextEncoder().encode(JSON.stringify(event)).byteLength
          if (eventBytes > maxOutputBytes - outputBytes) throw fail('AI turn output limit exceeded')
          outputBytes += eventBytes
          await step(()=>deps.revalidate(token,permit))
          stage = 'send_event'
          await step(async()=>{await emit(event)})
        }
      } catch (error) {
        if (!(controller.signal.aborted && controller.signal.reason instanceof TurnError && controller.signal.reason.message === 'AI turn cancelled')) logTurnFailure(turnId,stage,error)
        throw error instanceof TurnError || error instanceof ProviderResponseFailure ? error : fail('AI turn unavailable')
      } finally {
        clearTimeout(deadline)
        input.signal?.removeEventListener('abort',disconnect)
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
      if (disposed) throw fail('AI turn unavailable')
      if (!validId(turnId)) return false
      if (typeof token !== 'string') throw fail('AI turn unavailable')
      if (cancellationLookups.size >= maxActive) throw fail('AI cancellation capacity reached')
      const lookup = Promise.resolve().then(()=>{if(disposed)throw fail('AI turn unavailable');return deps.identity(token)})
      cancellationLookups.add(lookup)
      // A timed-out lookup still owns its slot until the dependency actually settles.
      void lookup.then(()=>cancellationLookups.delete(lookup),()=>cancellationLookups.delete(lookup))
      let deadline: ReturnType<typeof setTimeout> | undefined
      let stop!: () => void
      const shutdown = new Promise<never>((_,reject)=>{stop=()=>reject(fail('AI turn unavailable'));cancellationStops.add(stop)})
      const expired = new Promise<never>((_resolve,reject)=>{
        deadline = setTimeout(()=>reject(fail('AI cancellation timed out')),cancelTimeoutMs)
      })
      try {
        const identity = await Promise.race([lookup,expired,shutdown])
        if (disposed) throw fail('AI turn unavailable')
        const controller = active.get(identityKey(identity)+':'+turnId)
        if (!controller) return false
        controller.abort(fail('AI turn cancelled'))
        return true
      } catch (error) {
        throw error instanceof TurnError ? error : fail('AI turn unavailable')
      } finally { clearTimeout(deadline); cancellationStops.delete(stop) }
    },
  }
}
