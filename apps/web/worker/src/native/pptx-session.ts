import { matchesElementRef } from '@genoffice/pptx-engine/identity'
import { openPptx, savePptx, type OpenedPptx } from '@genoffice/pptx-engine'
import { runTxn, elementDurableId, slideDurableId, type Op } from '@genoffice/pptx-ops'
import { buildRenderSlide, type RenderSlide } from '@genoffice/pptx-render'
import { assertZipInflatesWithinLimits } from '@genoffice/zip-gate'

/** In-process reuse seam, NOT an authenticated service, durable revision ledger or sandbox.
 * No network, filesystem paths, global session registry or persistent save acknowledgements.
 * Caller must close handles and provide isolation/quotas before any untrusted deployment.
 */
export interface PptxSelection {
  generation: number
  slide: {index: number; id: string | undefined}
  element?: {id: string; type: string}
}
export interface PptxSession {
  undo(expectedGeneration: number, signal?: AbortSignal): Promise<{generation:number}>
  redo(expectedGeneration: number, signal?: AbortSignal): Promise<{generation:number}>
  selection(expectedGeneration: number, slide: number, elementId?: string, signal?: AbortSignal): Promise<PptxSelection>
  apply(expectedGeneration: number, ops: unknown, signal?: AbortSignal): Promise<{generation:number}>
  render(expectedGeneration: number, slide: number, signal?: AbortSignal): Promise<RenderSlide>
  exportBytes(expectedGeneration: number, signal?: AbortSignal): Promise<{generation:number;bytes:Uint8Array}>
  close(): void
}
const MAX_INPUT = 32 * 1024 * 1024
const MAX_PAYLOAD = 256 * 1024
const ZIP_LIMITS = {maxParts:1500, maxPartBytes:8*1024*1024, maxTotalBytes:64*1024*1024}
function aborted(signal?: AbortSignal) { if (signal?.aborted) throw new Error('ABORTED') }
function record(value: unknown): value is Record<string,unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function keys(value: Record<string,unknown>, allowed: string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('UNSUPPORTED_FIELD')
}
/** JSON-only, slide-local text slice. Never forward TxnRequest.parts, isolation, or arbitrary ops. */
function captureOps(input: unknown): Op[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > 100) throw new Error('OPS_LIMIT')
  let json: string
  try { json=JSON.stringify(input) } catch { throw new Error('INVALID_OPS') }
  if (new TextEncoder().encode(json).byteLength > MAX_PAYLOAD) throw new Error('PAYLOAD_LIMIT')
  const captured: unknown[]=JSON.parse(json)
  for (const value of captured) {
    if (!record(value) || value.op !== 'setText') throw new Error('UNSUPPORTED_OP')
    keys(value,['op','target','paragraphs'])
    const target=value.target
    if (!record(target)) throw new Error('INVALID_TARGET')
    keys(target,['slide','el'])
    if (!Number.isSafeInteger(target.slide) || (target.slide as number)<0 || typeof target.el!=='string' || !target.el || target.el.length>256) throw new Error('INVALID_TARGET')
    if (!Array.isArray(value.paragraphs) || value.paragraphs.length>1000) throw new Error('INVALID_PARAGRAPHS')
    for (const paragraph of value.paragraphs) {
      if (!record(paragraph) || !Array.isArray(paragraph.runs) || paragraph.runs.length>1000) throw new Error('INVALID_PARAGRAPHS')
      keys(paragraph,['runs'])
      for (const run of paragraph.runs) {
        if (!record(run) || typeof run.text!=='string' || (run.bold!==undefined && typeof run.bold!=='boolean')) throw new Error('INVALID_RUN')
        keys(run,['text','bold'])
      }
    }
  }
  return captured as Op[]
}
export async function createPptxSession(bytes: Uint8Array, signal?: AbortSignal): Promise<PptxSession> {
  aborted(signal)
  if (!(bytes instanceof Uint8Array) || bytes.byteLength===0 || bytes.byteLength>MAX_INPUT) throw new Error('INPUT_LIMIT')
  // Copy before the first await: the caller cannot alter the package while the gate parses it.
  const input=Uint8Array.from(bytes)
  await assertZipInflatesWithinLimits(input,ZIP_LIMITS)
  aborted(signal)
  let opened: OpenedPptx | undefined=await openPptx(input)
  aborted(signal)
  type Snapshot = {slides: OpenedPptx['deck']['slides']; size: OpenedPptx['deck']['size']; entries: Map<string, Uint8Array>; cost: number}
  // Conservative logical retention budget, not a process/RSS memory limit.
  const MAX_HISTORY = 8
  const MAX_HISTORY_BYTES = 64 * 1024 * 1024
  const past: Snapshot[] = [], future: Snapshot[] = []
  function historyCost(state: OpenedPptx): number {
    let cost = new TextEncoder().encode(JSON.stringify(state.deck.slides)).byteLength
    for (const [name, bytes] of state.archive.entries) cost += bytes.byteLength + new TextEncoder().encode(name).byteLength
    if (cost > MAX_HISTORY_BYTES) throw new Error('HISTORY_LIMIT')
    return cost
  }
  function snapshot(state: OpenedPptx): Snapshot {
    const cost=historyCost(state)
    return {slides: structuredClone(state.deck.slides), size: {...state.deck.size}, entries: new Map(state.archive.entries), cost}
  }
  function retain(stack: Snapshot[], value: Snapshot) {
    stack.push(value)
    while (past.length + future.length > MAX_HISTORY || [...past,...future].reduce((n,s)=>n+s.cost,0)>MAX_HISTORY_BYTES) {
      // Evict the farthest undo point first; then the farthest redo point.
      if (past.length) past.shift(); else future.shift()
    }
  }
  function restore(state: OpenedPptx, value: Snapshot) {
    state.deck.slides=value.slides; state.deck.size=value.size
    state.archive.entries.clear()
    for (const [name, bytes] of value.entries) state.archive.entries.set(name,bytes)
  }
  let generation=0
  let queue: Promise<unknown>=Promise.resolve()
  let pending=0
  function check(expected: number, signal?: AbortSignal): OpenedPptx {
    if (!opened) throw new Error('SESSION_CLOSED')
    aborted(signal)
    if (!Number.isSafeInteger(expected) || expected!==generation) throw new Error('GENERATION_CONFLICT')
    return opened
  }
  function enqueue<T>(expected:number, signal:AbortSignal|undefined, work:(state:OpenedPptx)=>T|Promise<T>):Promise<T> {
    if (!opened) return Promise.reject(new Error('SESSION_CLOSED'))
    if (pending>=32) return Promise.reject(new Error('QUEUE_LIMIT'))
    pending++
    const result=queue.then(()=>work(check(expected,signal)))
    // Recover failed operations so one rejection cannot poison later commands.
    queue=result.then(()=>{pending--},()=>{pending--})
    return result
  }
  function travel(expected: number, signal: AbortSignal | undefined, from: Snapshot[], to: Snapshot[]) {
    return enqueue(expected,signal,state=>{
      if (!from.length) throw new Error('HISTORY_EMPTY')
      const current=snapshot(state)
      const target=from.pop()!
      restore(state,target)
      retain(to,current)
      generation++
      return {generation}
    })
  }
  return {
    undo(expected,signal) {return travel(expected,signal,past,future)},
    redo(expected,signal) {return travel(expected,signal,future,past)},
    selection(expected,slide,elementId,signal) {
      return enqueue(expected,signal,state=>{
        if (!Number.isSafeInteger(slide) || slide<0 || slide>=state.deck.slides.length) throw new Error('INVALID_SLIDE')
        const selected=state.deck.slides[slide]!
        const context: PptxSelection={generation,slide:{index:slide,id:slideDurableId(selected)}}
        if (elementId!==undefined) {
          if (typeof elementId!=='string' || !elementId || elementId.length>256) throw new Error('INVALID_ELEMENT')
          // Include engine aliases: a canonical ID must not address another element via an alias.
          if (selected.elements.filter(e=>matchesElementRef(e,elementId)).length>1) throw new Error('AMBIGUOUS_ELEMENT')
          const element=selected.elements.find(e=>elementDurableId(e)===elementId)
          if (!element) throw new Error('INVALID_ELEMENT')
          context.element={id:elementId,type:element.type}
        }
        return context
      })
    },
    async apply(expected, ops, signal) {
      const captured=captureOps(ops)
      return enqueue(expected,signal,state=>{
        // The native resolver accepts parse-time, canonical and cNvPr aliases.
        // Reject collisions across all those forms before any batch mutation.
        for (const op of captured) {
          const slide=state.deck.slides[op.target!.slide as number]
          if (slide && slide.elements.filter(e=>matchesElementRef(e,op.target!.el as string)).length>1) throw new Error('AMBIGUOUS_ELEMENT')
        }
        const before=snapshot(state)
        const result=runTxn(state,{isolation:'atomic',ops:captured})
        if (!result.applied) throw new Error('OP_REJECTED')
        try { historyCost(state) } catch (error) { restore(state,before); throw error }
        future.length=0
        retain(past,before)
        generation++
        return {generation}
      })
    },
    render(expected,slide,signal) {
      return enqueue(expected,signal,state=>{
        if (!Number.isSafeInteger(slide) || slide<0 || slide>=state.deck.slides.length) throw new Error('INVALID_SLIDE')
        // No media resolver / system font access yet: not a visual-fidelity or image preview gate.
        return structuredClone(buildRenderSlide(state.deck.slides[slide]!,state.deck.size,{fitWidthPx:960,slideNo:slide+1}))
      })
    },
    exportBytes(expected,signal) {
      return enqueue(expected,signal,async state=>{
        const bytes=await savePptx(state)
        check(expected,signal)
        // Download bytes only. Never calls commitSaved or marks a durable revision as saved.
        return {generation,bytes}
      })
    },
    close() { opened=undefined; past.length=0; future.length=0 },
  }
}
