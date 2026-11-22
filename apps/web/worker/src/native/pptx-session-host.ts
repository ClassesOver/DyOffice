import type {SlideAnimation,LinkTarget} from '@genoffice/pptx-engine'
export type AnimationItem={sourceId:string;targetName:string}&Omit<SlideAnimation,'spid'>
type LinkTargetOp=LinkTarget
export type RunLink = {sourceId:string;paraIndex:number;runIndex:number;target:LinkTarget}
import { fork } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Parent-side seam for one forked PPTX session child. Untrusted packages are parsed and
 * mutated only inside the child; this module deliberately imports no @genoffice engine code,
 * so API-process callers never load the parser at all. Handles bind to one fileId/revision
 * pair, stay generation-fenced per call, and reject once the child exits or times out. */
export interface SlidesRenderNodeLike { type: string; [key: string]: unknown }
export interface SlidesRenderSlideLike { widthPx: number; heightPx: number; scale: number; nodes: SlidesRenderNodeLike[]; partPath?: string }
export interface SlidesMasterView {partPath:string; kind:'master'|'layout'; name:string; slide:SlidesRenderSlideLike}
export interface SlidesMasterEditResult {
  generation:number; stateGeneration:number; canUndo:boolean; canRedo:boolean
  slide:SlidesRenderSlideLike; sourceId?:string
}
export interface PptxChildBinding { fileId: string; revision: string }
export interface SlidesStepView { generation: number; stateGeneration: number; canUndo: boolean; canRedo: boolean; size: {cx:number;cy:number}; slides: SlidesRenderSlideLike[] }
/** The child's apply result: the applied transaction records plus the post-transaction deck
 * outline (durable slide ids and part paths) that drives changed/order reporting. Records
 * carry the original op object (`op.op` is the op name) per the executor journal. */
export interface SlidesCreatedEntryView { slide: number; index: number; id: string }
export interface SlidesApplyView {
  generation: number; stateGeneration: number; canUndo: boolean; canRedo: boolean
  records: Array<{ op: { op: string }; slideId?: string; created?: string[]; after?: unknown }>
  transaction: { applied: boolean; dryRun?: boolean; plan?: string[]; failures?: Array<{ index: number; error: string }>; records?: Array<{ op: { op: string }; slideId?: string; created?: string[]; after?: unknown }> }
  count: number; size: { cx: number; cy: number }; slideIds: string[]; paths: string[]
  created: SlidesCreatedEntryView[]
}
export type SlidesImageCommand =
  | {mode:'insert';slide:number;bytes:Uint8Array;ext:string} & (
      {offset:{x:number;y:number;cx:number;cy:number};placement?:never} | {placement:'natural';offset?:never}
    )
  | {mode:'replace';slide:number;sourceId:string;bytes:Uint8Array;ext:string;keepSrcRect?:boolean}
export interface SlidesOutlineView { count: number; size: { cx: number; cy: number }; slideIds: string[]; paths: string[]; defaultFont?: string; writeProtected?: true }
export interface PptxChildSession {
  apply(expectedGeneration: number, ops: unknown, signal?: AbortSignal, options?: { isolation?: 'atomic' | 'per_op'; dryRun?: boolean }): Promise<SlidesApplyView>
  editChart(expectedGeneration:number,slide:number,sourceId:string,patch:Record<string,unknown>,signal?:AbortSignal):Promise<{generation:number;stateGeneration:number;canUndo:boolean;canRedo:boolean;slide:SlidesRenderSlideLike;sourceId:string}>
  generatePage(expectedGeneration:number,specJson:string,images:Array<{url:string;bytes:Uint8Array;ext:string}>,signal?:AbortSignal):Promise<{marker:string;imageFailures:string[];imageWarnings:string[]}>
  landGeneratedPages(expectedGeneration:number,markers:string[],mode:'replace'|'append'|'replace_at'|'insert_at',atIndex?:number,signal?:AbortSignal):Promise<SlidesApplyView>
  applyImage(expectedGeneration:number,input:SlidesImageCommand,signal?:AbortSignal):Promise<SlidesApplyView>
  undo(expectedGeneration: number, signal?: AbortSignal): Promise<SlidesStepView>
  redo(expectedGeneration: number, signal?: AbortSignal): Promise<SlidesStepView>
  beginHistoryBatch(expectedGeneration:number,signal?:AbortSignal):Promise<boolean>
  endHistoryBatch(expectedGeneration:number,signal?:AbortSignal):Promise<{snapshotId:number|null;canUndo:boolean;canRedo:boolean}>
  restoreSnapshot(expectedGeneration:number,snapshotId:number,signal?:AbortSignal):Promise<SlidesStepView|null>
  render(expectedGeneration: number, slide: number, fitWidthPx?: number, signal?: AbortSignal): Promise<SlidesRenderSlideLike>
  chartData(expectedGeneration:number,slide:number,sourceId:string,signal?:AbortSignal):Promise<ReturnType<typeof import('@genoffice/pptx-engine').getChartElementData>>
  chartColorSchemes(expectedGeneration:number,signal?:AbortSignal):Promise<Array<{key:string;colors:string[]}>>
  animations(expectedGeneration:number,slide:number,signal?:AbortSignal):Promise<AnimationItem[]>
  links(expectedGeneration:number,slide:number,signal?:AbortSignal):Promise<Array<{sourceId:string;target:LinkTargetOp}>>
  runLinks(expectedGeneration:number,slide:number,signal?:AbortSignal):Promise<RunLink[]>
  notes(expectedGeneration: number, slide: number, signal?: AbortSignal): Promise<string>
  comments(expectedGeneration: number, slide: number, signal?: AbortSignal): Promise<Array<{authorId:number;author:string;initials:string;dt:string;idx:number;text:string}>>
  layouts(expectedGeneration: number, signal?: AbortSignal): Promise<{layouts:Array<{path:string;name:string;layoutType:string;placeholders:Array<{type:string;idx:string;x:number;y:number;cx:number;cy:number;hint:string}>}>;size:{cx:number;cy:number}}>
  masterParts(expectedGeneration: number, fitWidthPx?: number, signal?: AbortSignal): Promise<SlidesMasterView[]>
  applyMaster(expectedGeneration: number, partPath: string, operation: unknown, fitWidthPx?: number, signal?: AbortSignal): Promise<SlidesMasterEditResult>
  renderAll(expectedGeneration: number, fitWidthPx?: number, signal?: AbortSignal): Promise<SlidesRenderSlideLike[]>
  outline(expectedGeneration: number, signal?: AbortSignal): Promise<SlidesOutlineView>
  exportBytes(expectedGeneration: number, signal?: AbortSignal): Promise<{ generation: number; bytes: Uint8Array }>
  close(): void
}
interface ChildMessage { snapshotId?:number; id: number; m: string; expected?: number; ops?: unknown; image?:SlidesImageCommand; isolation?: 'atomic' | 'per_op'; dryRun?: boolean; slide?: number; width?: number; sourceId?:string;patch?:Record<string,unknown>;specJson?:string;images?:Array<{url:string;bytes:Uint8Array;ext:string}>;markers?:string[];mode?:'replace'|'append'|'replace_at'|'insert_at';atIndex?:number; bytes?: Uint8Array; binding?: PptxChildBinding; partPath?:string; operation?:unknown }
export interface IsolatedPptxSessionOptions { unsafeTestOnly?: boolean; experimental?: boolean; timeoutMs?: number; childModule?: URL; tsxModule?: URL; mdHooks?: URL; signal?: AbortSignal }
/** Mirrors the in-process session gate: no oversized package is ever handed to a child. */
const MAX_INPUT_BYTES = 32 * 1024 * 1024
/** Fork one isolated Node child, hand it fixture/uploaded bytes, and return a generation-fenced
 * proxy. Experimental/test fork: the child never shares the API heap, a
 * crash only fails its own session, and every call is bounded by timeoutMs. */
export async function openIsolatedPptxSession(input: {fileId: string; revision: string; bytes: Uint8Array}, options: IsolatedPptxSessionOptions = {}): Promise<PptxChildSession & {binding: PptxChildBinding}> {
  const {signal} = options
  signal?.throwIfAborted()
  if(process.env.NODE_ENV==='production'||(options.experimental!==true&&(process.env.NODE_ENV!=='test'||options.unsafeTestOnly!==true)))throw new Error('PPTX_OS_ISOLATION_UNAVAILABLE')
  if (!Number.isSafeInteger(input.bytes.byteLength) || input.bytes.byteLength===0 || input.bytes.byteLength>MAX_INPUT_BYTES) throw new Error('INPUT_LIMIT')
  const timeoutMs=options.timeoutMs ?? 30_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs<1000 || timeoutMs>120_000) throw new Error('INVALID_TIMEOUT')
  const childModule=options.childModule ?? new URL('./pptx-session-child.ts',import.meta.url)
  const tsxModule=options.tsxModule ?? pathToFileURL(createRequire(fileURLToPath(new URL('../../../package.json',import.meta.url))).resolve('tsx'))
  const mdHooks=options.mdHooks ?? new URL('./pptx-md-raw.mjs',import.meta.url)
  const binding={fileId:input.fileId,revision:input.revision}
  // tsx transforms the TypeScript child; the raw-import hook runs ahead of its load chain so
  // pptx-ops' `*.md?raw` op guides resolve as text modules inside the child.
  const child=fork(fileURLToPath(childModule),[],{serialization:'advanced',env:{PATH:process.env.PATH??'',NODE_ENV:process.env.NODE_ENV==='test'?'test':'development'},stdio:['ignore','ignore','ignore','ipc'],execArgv:['--import',fileURLToPath(tsxModule),'--import',fileURLToPath(mdHooks)]})
  let nextId=1
  const pending=new Map<number,{resolve:(value:unknown)=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout}>()
  let closed=false
  const failAll=(error:Error)=>{
    closed=true
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error) }
    pending.clear()
  }
  child.on('message',(raw: {id:number;ok:boolean;result?:unknown;error?:string})=>{
    const entry=pending.get(raw.id)
    if (!entry) return
    pending.delete(raw.id)
    clearTimeout(entry.timer)
    if (raw.ok) entry.resolve(raw.result)
    else entry.reject(new Error(raw.error ?? 'CHILD_ERROR'))
  })
  child.on('exit',()=>{ if (!closed) failAll(new Error('SESSION_CLOSED')) })
  child.on('error',()=>{ if (!closed) failAll(new Error('SESSION_CLOSED')) })
  function call<T>(message: Omit<ChildMessage,'id'>): Promise<T> {
    if (closed || child.exitCode!==null) return Promise.reject(new Error('SESSION_CLOSED'))
    const id=nextId++
    return new Promise<T>((resolve,reject)=>{
      const timer=setTimeout(()=>{
        pending.delete(id)
        closed=true
        child.kill('SIGKILL')
        reject(new Error('SESSION_TIMEOUT'))
      },timeoutMs)
      pending.set(id,{resolve:resolve as (value:unknown)=>void,reject,timer})
      child.send({...message,id} satisfies ChildMessage,()=>{})
    })
  }
  const abortOpen = () => {
    failAll(new Error('ABORTED'))
    child.kill('SIGKILL')
  }
  signal?.addEventListener('abort',abortOpen,{once:true})
  try {
    await call({m:'open',binding,bytes:input.bytes})
    signal?.throwIfAborted()
  } catch (error) {
    // No session handle reaches the caller on failure, so close the child here.
    if (!closed) {
      failAll(new Error('SESSION_CLOSED'))
      child.kill('SIGKILL')
    }
    throw error
  } finally {
    signal?.removeEventListener('abort',abortOpen)
  }
  return {
    binding,
    apply(expected,ops,signal,options = {}){
      if (signal?.aborted) return Promise.reject(new Error('ABORTED'))
      // Once sent, the atomic transaction lands in the child; later aborts must not
      // desynchronize the caller's generation, so the promise always settles.
      return call({m:'apply',expected,ops,isolation:options.isolation,dryRun:options.dryRun})
    },
    applyImage(expected,input,signal){
      if(signal?.aborted)return Promise.reject(new Error('ABORTED'))
      return call({m:'applyImage',expected,image:input})
    },
    editChart(expected,slide,sourceId,patch,signal){if(signal?.aborted)return Promise.reject(new Error('ABORTED'));return call({m:'editChart',expected,slide,sourceId,patch})},
    generatePage(expected,specJson,images,signal){if(signal?.aborted)return Promise.reject(new Error('ABORTED'));return call({m:'generatePage',expected,specJson,images})},
    landGeneratedPages(expected,markers,mode,atIndex,signal){if(signal?.aborted)return Promise.reject(new Error('ABORTED'));return call({m:'landGeneratedPages',expected,markers,mode,atIndex})},
    undo(expected,signal){ if (signal?.aborted) return Promise.reject(new Error('ABORTED')); return call({m:'undo',expected}) },
    redo(expected,signal){ if (signal?.aborted) return Promise.reject(new Error('ABORTED')); return call({m:'redo',expected}) },
    beginHistoryBatch(expected,signal){if(signal?.aborted)return Promise.reject(new Error('ABORTED'));return call({m:'historyBatchBegin',expected})},
    endHistoryBatch(expected,signal){if(signal?.aborted)return Promise.reject(new Error('ABORTED'));return call({m:'historyBatchEnd',expected})},
    restoreSnapshot(expected,snapshotId,signal){if(signal?.aborted)return Promise.reject(new Error('ABORTED'));return call({m:'snapshotRestore',expected,snapshotId})},
    render(expected,slide,width,signal){ if (signal?.aborted) return Promise.reject(new Error('ABORTED')); return call({m:'render',expected,slide,width}) },
    chartData(expected,slide,sourceId,signal){if(signal?.aborted)return Promise.reject(new Error('ABORTED'));return call({m:'chartData',expected,slide,sourceId})},
    chartColorSchemes(expected,signal){if(signal?.aborted)return Promise.reject(new Error('ABORTED'));return call({m:'chartColorSchemes',expected})},
    animations(expected,slide,signal){if(signal?.aborted)return Promise.reject(new Error('ABORTED'));return call({m:'animations',expected,slide})},
    links(expected,slide,signal){if(signal?.aborted)return Promise.reject(new Error('ABORTED'));return call({m:'links',expected,slide})},
    runLinks(expected,slide,signal){if(signal?.aborted)return Promise.reject(new Error('ABORTED'));return call({m:'runLinks',expected,slide})},
    notes(expected,slide,signal){ if (signal?.aborted) return Promise.reject(new Error('ABORTED')); return call({m:'notes',expected,slide}) },
    comments(expected,slide,signal){ if (signal?.aborted) return Promise.reject(new Error('ABORTED')); return call({m:'comments',expected,slide}) },
    layouts(expected,signal){ if (signal?.aborted) return Promise.reject(new Error('ABORTED')); return call({m:'layouts',expected}) },
    masterParts(expected,width,signal){ if (signal?.aborted) return Promise.reject(new Error('ABORTED')); return call({m:'masterParts',expected,width}) },
    applyMaster(expected,partPath,operation,width,signal){ if (signal?.aborted) return Promise.reject(new Error('ABORTED')); return call({m:'applyMaster',expected,partPath,operation,width}) },
    renderAll(expected,width,signal){ if (signal?.aborted) return Promise.reject(new Error('ABORTED')); return call({m:'renderAll',expected,width}) },
    outline(expected,signal){ if (signal?.aborted) return Promise.reject(new Error('ABORTED')); return call({m:'outline',expected}) },
    exportBytes(expected,signal){ if (signal?.aborted) return Promise.reject(new Error('ABORTED')); return call({m:'export',expected}) },
    close(){
      if (closed) return
      closed=true
      failAll(new Error('SESSION_CLOSED'))
      try { child.send({m:'close',id:nextId++} satisfies ChildMessage) } catch { /* already gone */ }
      const deadline=setTimeout(()=>child.kill('SIGKILL'),1000).unref()
      child.once('exit',()=>clearTimeout(deadline))
    },
  }
}
