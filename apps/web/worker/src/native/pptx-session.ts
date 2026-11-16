import { openPptx, savePptx, parseTheme, matchesElementRef, elementDurableId, slideDurableId, type OpenedPptx, type Slide, type SlideSize } from '@genoffice/pptx-engine'
import { runTxn, type Op, type OpRecord } from '@genoffice/pptx-ops'
import { buildRenderSlide, type RenderSlide } from '@genoffice/pptx-render'
import { assertZipInflatesWithinLimits } from '@genoffice/zip-gate'

/** In-process reuse seam, NOT an authenticated service, durable revision ledger or sandbox.
 * No network, filesystem paths, global session registry or persistent save acknowledgements.
 * Caller must close handles and provide isolation/quotas before any untrusted deployment.
 *
 * Isolation: untrusted PPTX bytes are parsed and mutated ONLY inside createPptxSession.
 * The parent-side openIsolatedPptxSession factory hosts one session per forked Node child
 * process, so uploaded packages never touch the API process heap; payloads stay bounded by
 * MAX_INPUT/MAX_PAYLOAD/ZIP_LIMITS below and every handle is bound to one file/revision.
 */
export type { RenderSlide } from '@genoffice/pptx-render'
export interface SlidesCreatedEntry { slide: number; index: number; id: string }
export interface SlidesApplyResult {
  generation: number; stateGeneration: number; canUndo: boolean; canRedo: boolean
  records: OpRecord[]; slideIds: string[]; paths: string[]; created: SlidesCreatedEntry[]
}
export interface SlidesStepResult { generation: number; stateGeneration: number; canUndo: boolean; canRedo: boolean; slides: RenderSlide[] }
export interface SlidesOutline { count: number; size: SlideSize; slideIds: string[]; paths: string[]; defaultFont?: string }
export interface PptxSession {
  apply(expectedGeneration: number, ops: unknown, signal?: AbortSignal): Promise<SlidesApplyResult>
  undo(expectedGeneration: number, signal?: AbortSignal): Promise<SlidesStepResult>
  redo(expectedGeneration: number, signal?: AbortSignal): Promise<SlidesStepResult>
  render(expectedGeneration: number, slide: number, fitWidthPx?: number, signal?: AbortSignal): Promise<RenderSlide>
  renderAll(expectedGeneration: number, fitWidthPx?: number, signal?: AbortSignal): Promise<RenderSlide[]>
  outline(expectedGeneration: number, signal?: AbortSignal): Promise<SlidesOutline>
  exportBytes(expectedGeneration: number, signal?: AbortSignal): Promise<{generation:number;bytes:Uint8Array}>
  close(): void
}
const MAX_INPUT = 32 * 1024 * 1024
const MAX_PAYLOAD = 256 * 1024
const ZIP_LIMITS = {maxParts:1500, maxPartBytes:8*1024*1024, maxTotalBytes:64*1024*1024}
// Undo history is whole-deck snapshots (slides deep, archive entries shallow): bound both the
// count and the estimated retained bytes so a hostile deck cannot grow the session without limit.
const MAX_HISTORY = 50, MAX_HISTORY_BYTES = 16 * 1024 * 1024
const MAX_RENDER_SLIDES = 200
const MIN_FIT_WIDTH_PX = 320, MAX_FIT_WIDTH_PX = 4096, DEFAULT_FIT_WIDTH_PX = 960
const EMU_MAX = 2147483647, ROT_DEG_MAX = 35791
/** T10 acceptance whitelist: slide add/delete/duplicate/reorder, element add/delete/transform,
 * fill/stroke/text/font/paragraph edits, reorder/ungroup and deck find&replace. The `group`
 * field addresses a member inside a group and is accepted only where the op registry reads it.
 * Media bytes, master-part targets, grouping and journal controls stay out. */
const OP_FIELDS: Record<string, readonly string[]> = {
  setText: ['op','target','paragraphs','group'],
  setFill: ['op','target','fill'],
  setStroke: ['op','target','stroke'],
  addElement: ['op','target','offset','kind','paragraphs','fill','stroke'],
  deleteElement: ['op','target'],
  setTransform: ['op','target','box','rotDeg','group'],
  reorderElement: ['op','target','dir'],
  ungroupElement: ['op','target'],
  setFont: ['op','target','font','group'],
  setParagraphFormat: ['op','target','format','group'],
  findReplace: ['op','find','replace','matchCase','firstOnly','slideIndex','elementId'],
  addBlankSlide: ['op','target'],
  addSlideWithLayout: ['op','target','layout','layoutPath'],
  duplicateSlide: ['op','target','clearText'],
  deleteSlide: ['op','target'],
  moveSlide: ['op','target','to'],
  setNotes: ['op','target','text'],
}
const ADDING_SLIDES = new Set(['addBlankSlide','addSlideWithLayout','duplicateSlide'])
const PARAGRAPH_KEYS = ['runs','align','level','srcPara']
const RUN_KEYS = ['text','bold','italic','underline','strike','fontSize','fontFamily','color','baseline','srcRun']
function aborted(signal?: AbortSignal) { if (signal?.aborted) throw new Error('ABORTED') }
function record(value: unknown): value is Record<string,unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function keys(value: Record<string,unknown>, allowed: string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('UNSUPPORTED_FIELD')
}
function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && /^#?[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$/.test(value.trim())
}
/** JSON surface addresses slides by 0-based index or the durable "s_<n>" id that survives reorder. */
function isSlideRef(value: unknown): boolean {
  return (Number.isSafeInteger(value) && (value as number) >= 0)
    || (typeof value === 'string' && /^s_[A-Za-z0-9_]{1,127}$/.test(value))
}
function checkTarget(value: unknown) {
  if (value === undefined) return
  if (!record(value)) throw new Error('INVALID_TARGET')
  keys(value, ['slide','el'])
  if (value.slide !== undefined && !isSlideRef(value.slide)) throw new Error('INVALID_TARGET')
  if (value.el !== undefined && (typeof value.el !== 'string' || !value.el || value.el.length > 256)) throw new Error('INVALID_TARGET')
}
function emu(value: unknown, minimum = -EMU_MAX) {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= EMU_MAX
}
function geometry(value: unknown, field: string) {
  if (!record(value)) throw new Error(field)
  keys(value, ['x','y','cx','cy'])
  for (const key of ['x','y','cx','cy']) if (!emu(value[key], key === 'x' || key === 'y' ? -EMU_MAX : 0)) throw new Error(field)
}
function gradientStops(value: unknown, field: string) {
  if (!Array.isArray(value) || value.length < 2 || value.length > 10) throw new Error(field)
  for (const stop of value) {
    if (!record(stop)) throw new Error(field)
    keys(stop, ['pos','color'])
    if (typeof stop.pos !== 'number' || !Number.isFinite(stop.pos) || (stop.pos as number) < 0 || (stop.pos as number) > 1) throw new Error(field)
    if (!isHexColor(stop.color)) throw new Error(field)
  }
}
function angle(value: unknown, field: string) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(field)
}
function checkFillPatch(value: unknown) {
  if (typeof value === 'string') { if (value !== 'none' && !isHexColor(value)) throw new Error('INVALID_FILL'); return }
  if (!record(value)) throw new Error('INVALID_FILL')
  keys(value, ['stops','angle'])
  gradientStops(value.stops, 'INVALID_FILL')
  if (value.angle !== undefined) angle(value.angle, 'INVALID_FILL')
}
function checkStrokePatch(value: unknown, allowGradient: boolean) {
  if (value === null) { if (allowGradient) return; throw new Error('INVALID_STROKE') }
  if (!record(value)) throw new Error('INVALID_STROKE')
  keys(value, allowGradient ? ['color','widthEmu','gradient'] : ['color','widthEmu'])
  if (!isHexColor(value.color)) throw new Error('INVALID_STROKE')
  if (typeof value.widthEmu !== 'number' || !Number.isFinite(value.widthEmu) || (value.widthEmu as number) <= 0 || (value.widthEmu as number) > EMU_MAX) throw new Error('INVALID_STROKE')
  if (value.gradient !== undefined) {
    if (!allowGradient || !record(value.gradient)) throw new Error('INVALID_STROKE')
    keys(value.gradient, ['stops','angle'])
    gradientStops(value.gradient.stops, 'INVALID_STROKE')
    if (value.gradient.angle !== undefined) angle(value.gradient.angle, 'INVALID_STROKE')
  }
}
function checkParagraphs(value: unknown) {
  if (!Array.isArray(value) || value.length > 1000) throw new Error('INVALID_PARAGRAPHS')
  for (const paragraph of value) {
    if (!record(paragraph)) throw new Error('INVALID_PARAGRAPHS')
    keys(paragraph, PARAGRAPH_KEYS)
    if (paragraph.align !== undefined && !['left','center','right','justify'].includes(paragraph.align as string)) throw new Error('INVALID_PARAGRAPHS')
    if (paragraph.level !== undefined && (!Number.isSafeInteger(paragraph.level) || (paragraph.level as number) < 0 || (paragraph.level as number) > 8)) throw new Error('INVALID_PARAGRAPHS')
    if (paragraph.srcPara !== undefined && (!Number.isSafeInteger(paragraph.srcPara) || (paragraph.srcPara as number) < 0)) throw new Error('INVALID_PARAGRAPHS')
    if (!Array.isArray(paragraph.runs) || paragraph.runs.length > 1000) throw new Error('INVALID_PARAGRAPHS')
    for (const run of paragraph.runs) {
      if (!record(run) || typeof run.text !== 'string') throw new Error('INVALID_RUN')
      keys(run, RUN_KEYS)
      for (const flag of ['bold','italic','underline','strike']) if (run[flag] !== undefined && typeof run[flag] !== 'boolean') throw new Error('INVALID_RUN')
      if (run.fontSize !== undefined && (typeof run.fontSize !== 'number' || !Number.isFinite(run.fontSize) || (run.fontSize as number) <= 0 || (run.fontSize as number) > 4000)) throw new Error('INVALID_RUN')
      if (run.fontFamily !== undefined && (typeof run.fontFamily !== 'string' || (run.fontFamily as string).length > 256)) throw new Error('INVALID_RUN')
      if (run.color !== undefined && !isHexColor(run.color)) throw new Error('INVALID_RUN')
      if (run.baseline !== undefined && (typeof run.baseline !== 'number' || !Number.isFinite(run.baseline))) throw new Error('INVALID_RUN')
      if (run.srcRun !== undefined && (!Number.isSafeInteger(run.srcRun) || (run.srcRun as number) < 0)) throw new Error('INVALID_RUN')
    }
  }
}
function checkLayoutRef(value: unknown) {
  if (Number.isSafeInteger(value) && (value as number) >= 0) return
  if (typeof value === 'string' && value.length > 0 && value.length <= 512 && /^[\w./ -]+$/.test(value)) return
  throw new Error('INVALID_LAYOUT')
}
/** JSON-only command surface. Never forward TxnRequest.parts, isolation, master-part targets,
 * media bytes or arbitrary op names: each op is field-checked against the whitelist above, then
 * re-validated and journaled by the op registry inside the atomic transaction. */
function captureOps(input: unknown): Op[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > 100) throw new Error('OPS_LIMIT')
  let json: string
  try { json=JSON.stringify(input) } catch { throw new Error('INVALID_OPS') }
  if (new TextEncoder().encode(json).byteLength > MAX_PAYLOAD) throw new Error('PAYLOAD_LIMIT')
  const captured: unknown[]=JSON.parse(json)
  for (const value of captured) {
    if (!record(value) || typeof value.op !== 'string') throw new Error('UNSUPPORTED_OP')
    const fields = OP_FIELDS[value.op]
    if (!fields) throw new Error('UNSUPPORTED_OP')
    keys(value, [...fields])
    checkTarget(value.target)
    if (value.group !== undefined && (typeof value.group !== 'string' || !value.group || value.group.length > 256)) throw new Error('INVALID_TARGET')
    switch (value.op) {
      case 'setText':
        checkParagraphs(value.paragraphs)
        break
      case 'setFill':
        checkFillPatch(value.fill)
        break
      case 'setStroke':
        checkStrokePatch(value.stroke, true)
        break
      case 'addElement':
        geometry(value.offset, 'INVALID_GEOMETRY')
        if (typeof value.kind !== 'string' || !/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(value.kind)) throw new Error('INVALID_KIND')
        if (value.paragraphs !== undefined) checkParagraphs(value.paragraphs)
        if (value.fill !== undefined && !isHexColor(value.fill)) throw new Error('INVALID_FILL')
        if (value.stroke !== undefined) checkStrokePatch(value.stroke, false)
        break
      case 'setTransform':
        geometry(value.box, 'INVALID_GEOMETRY')
        if (value.rotDeg !== undefined && (typeof value.rotDeg !== 'number' || !Number.isFinite(value.rotDeg) || Math.abs(value.rotDeg as number) > ROT_DEG_MAX)) throw new Error('INVALID_ROTATION')
        break
      case 'addSlideWithLayout':
        checkLayoutRef(value.layout ?? value.layoutPath)
        break
      case 'duplicateSlide':
        if (value.clearText !== undefined && typeof value.clearText !== 'boolean') throw new Error('UNSUPPORTED_FIELD')
        break
      case 'moveSlide':
        if (!Number.isSafeInteger(value.to) || (value.to as number) < 0) throw new Error('INVALID_TARGET')
        break
      case 'setNotes':
        if (typeof value.text !== 'string' || value.text.length > 65536) throw new Error('INVALID_TEXT')
        break
      case 'reorderElement':
        if (!['front','back','forward','backward'].includes(String(value.dir))) throw new Error('INVALID_DIRECTION')
        break
      case 'setFont': {
        const font = value.font
        if (!record(font)) throw new Error('INVALID_FONT')
        keys(font, ['color','fontSizePt','fontSizeStep','fontFamily','bold','italic','underline','strike','baseline'])
        if (font.color !== undefined && !isHexColor(font.color)) throw new Error('INVALID_FILL')
        if (font.fontSizePt !== undefined && (typeof font.fontSizePt !== 'number' || !Number.isFinite(font.fontSizePt))) throw new Error('INVALID_FONT')
        if (font.fontFamily !== undefined && (typeof font.fontFamily !== 'string' || !font.fontFamily || String(font.fontFamily).length > 256)) throw new Error('INVALID_FONT')
        for (const flag of ['bold','italic','underline','strike'] as const) {
          if (font[flag] !== undefined && typeof font[flag] !== 'boolean') throw new Error('INVALID_FONT')
        }
        break
      }
      case 'setParagraphFormat': {
        const format = value.format
        if (!record(format)) throw new Error('INVALID_FORMAT')
        for (const [field, v] of Object.entries(format)) {
          if (['lineSpacingPct','spaceBeforePt','spaceAfterPt','bulletSizePct','bulletHangEmu','startAt'].includes(field)) {
            if (typeof v !== 'number' || !Number.isFinite(v) || (v as number) < -EMU_MAX || (v as number) > EMU_MAX) throw new Error('INVALID_FORMAT')
          }
        }
        break
      }
      case 'findReplace':
        if (typeof value.find !== 'string' || !value.find || value.find.length > 65536) throw new Error('INVALID_TEXT')
        if (typeof value.replace !== 'string' || value.replace.length > 65536) throw new Error('INVALID_TEXT')
        for (const flag of ['matchCase','firstOnly'] as const) {
          if (value[flag] !== undefined && typeof value[flag] !== 'boolean') throw new Error('UNSUPPORTED_FIELD')
        }
        if (value.slideIndex !== undefined && !Number.isSafeInteger(value.slideIndex)) throw new Error('INVALID_TARGET')
        if (value.elementId !== undefined && (typeof value.elementId !== 'string' || !value.elementId || value.elementId.length > 256)) throw new Error('INVALID_TARGET')
        break
    }
  }
  return captured as Op[]
}
function fitWidth(fitWidthPx?: number): number {
  if (fitWidthPx === undefined) return DEFAULT_FIT_WIDTH_PX
  if (!Number.isSafeInteger(fitWidthPx) || fitWidthPx < MIN_FIT_WIDTH_PX || fitWidthPx > MAX_FIT_WIDTH_PX) throw new Error('INVALID_FIT_WIDTH')
  return fitWidthPx
}
/** Same restore invariant as the executor: slides deep-cloned, archive entry map shallow-copied
 * (entry buffers are replaced wholesale, never mutated in place). */
interface HistorySnapshot { slides: Slide[]; size: SlideSize; entries: Map<string, Uint8Array>; bytes: number; atGeneration: number }
function estimate(slides: Slide[]): number {
  let bytes = 0
  for (const slide of slides) bytes += slide.originalXml.length * 2 + slide.elements.length * 1024 + 2048
  return bytes
}
function deckFont(state: OpenedPptx): string | undefined {
  for (const path of state.archive.entries.keys()) {
    if (!/^ppt\/theme\/theme\d+\.xml$/.test(path)) continue
    const xml = state.archive.readText(path)
    return xml ? parseTheme(xml).minorFont : undefined
  }
  return undefined
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
  let generation=0
  // The generation whose exact state the deck currently holds; a deck restored by undo/redo
  // maps back to the snapshot's pre-edit generation, which drives the caller's dirty tracking.
  let stateGeneration=0
  let queue: Promise<unknown>=Promise.resolve()
  let pending=0
  const undoStack: HistorySnapshot[]=[]; let undoBytes=0
  const redoStack: HistorySnapshot[]=[]; let redoBytes=0
  function snapshot(state: OpenedPptx): HistorySnapshot {
    const slides=structuredClone(state.deck.slides)
    return { slides, size: {cx: state.deck.size.cx, cy: state.deck.size.cy}, entries: new Map(state.archive.entries), bytes: estimate(slides), atGeneration: generation }
  }
  function restore(state: OpenedPptx, snap: HistorySnapshot): void {
    state.deck.slides=snap.slides
    state.deck.size=snap.size
    const entries=state.archive.entries
    entries.clear()
    for (const [path,buffer] of snap.entries) entries.set(path,buffer)
    stateGeneration=snap.atGeneration
  }
  function push(stack: HistorySnapshot[], snap: HistorySnapshot, used: () => number, drop: (bytes:number)=>void) {
    stack.push(snap)
    while (stack.length>MAX_HISTORY || (stack.length>1 && used()>MAX_HISTORY_BYTES)) drop(stack.shift()!.bytes)
  }
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
  function history(): {canUndo:boolean;canRedo:boolean} { return {canUndo: undoStack.length>0, canRedo: redoStack.length>0} }
  function outlineOf(state: OpenedPptx) {
    return { count: state.deck.slides.length, size: {cx: state.deck.size.cx, cy: state.deck.size.cy},
      slideIds: state.deck.slides.map(slideDurableId), paths: state.deck.slides.map(slide => slide.path) }
  }
  /** Bridge contract: add ops echo where the created element/slide landed, so the renderer can
   * select it without a re-fetch. Elements locate by slide index + z-order position; slide-add
   * ops locate the new page itself. */
  function createdOf(state: OpenedPptx, records: OpRecord[]): SlidesCreatedEntry[] {
    const created: SlidesCreatedEntry[] = []
    const elementAt=(id: string) => {
      for (let i=0;i<state.deck.slides.length;i++) {
        const elements=state.deck.slides[i]!.elements
        for (let j=0;j<elements.length;j++) {
          const el=elements[j]!
          if (matchesElementRef(el,id) || elementDurableId(el)===id) return {slide:i,index:j,id}
        }
      }
      return undefined
    }
    for (const rec of records) {
      const name=typeof rec.op === 'string' ? rec.op : String((rec.op as {op?: unknown}|undefined)?.op ?? '')
      for (const id of rec.created ?? []) {
        const located=elementAt(id)
        if (located) { created.push(located); continue }
        const slideIndex=state.deck.slides.findIndex(slide => slideDurableId(slide)===id)
        if (slideIndex>=0) created.push({slide:slideIndex,index:slideIndex,id})
      }
      if (!rec.created?.length && ADDING_SLIDES.has(name)) {
        const after=rec.after as {index?: unknown}|undefined
        if (typeof after?.index === 'number' && state.deck.slides[after.index]) {
          const id=slideDurableId(state.deck.slides[after.index]!)
          created.push({slide:after.index,index:after.index,id})
        }
      }
    }
    return created
  }
  function renderSlides(state: OpenedPptx, width: number): RenderSlide[] {
    if (state.deck.slides.length>MAX_RENDER_SLIDES) throw new Error('RENDER_LIMIT')
    // No media resolver / system font access yet: not a visual-fidelity or image preview gate.
    return state.deck.slides.map((slide,index)=>structuredClone(buildRenderSlide(slide,state.deck.size,{fitWidthPx:width,slideNo:index+1})))
  }
  return {
    async apply(expected, ops, signal) {
      const captured=captureOps(ops)
      return enqueue(expected,signal,state=>{
        const before=snapshot(state)
        const result=runTxn(state,{isolation:'atomic',ops:captured})
        if (!result.applied) throw new Error('OP_REJECTED')
        push(undoStack,before,()=>undoBytes,bytes=>{undoBytes-=bytes})
        redoStack.length=0; redoBytes=0
        generation++
        stateGeneration=generation
        return {generation,stateGeneration,...history(),records:result.records ?? [],...outlineOf(state),created:createdOf(state,result.records ?? [])}
      })
    },
    undo(expected,signal) {
      return enqueue(expected,signal,state=>{
        if (undoStack.length===0) throw new Error('NOTHING_TO_UNDO')
        const current=snapshot(state)
        const snap=undoStack.pop()!; undoBytes-=snap.bytes
        push(redoStack,current,()=>redoBytes,bytes=>{redoBytes-=bytes})
        restore(state,snap)
        generation++
        return {generation,stateGeneration,...history(),slides:renderSlides(state,DEFAULT_FIT_WIDTH_PX)}
      })
    },
    redo(expected,signal) {
      return enqueue(expected,signal,state=>{
        if (redoStack.length===0) throw new Error('NOTHING_TO_REDO')
        const current=snapshot(state)
        const snap=redoStack.pop()!; redoBytes-=snap.bytes
        push(undoStack,current,()=>undoBytes,bytes=>{undoBytes-=bytes})
        restore(state,snap)
        generation++
        return {generation,stateGeneration,...history(),slides:renderSlides(state,DEFAULT_FIT_WIDTH_PX)}
      })
    },
    render(expected,slide,width,signal) {
      return enqueue(expected,signal,state=>{
        if (!Number.isSafeInteger(slide) || slide<0 || slide>=state.deck.slides.length) throw new Error('INVALID_SLIDE')
        // No media resolver / system font access yet: not a visual-fidelity or image preview gate.
        return structuredClone(buildRenderSlide(state.deck.slides[slide]!,state.deck.size,{fitWidthPx:fitWidth(width),slideNo:slide+1}))
      })
    },
    renderAll(expected,width,signal) {
      return enqueue(expected,signal,state=>renderSlides(state,fitWidth(width)))
    },
    outline(expected,signal) {
      return enqueue(expected,signal,state=>({...outlineOf(state),defaultFont:deckFont(state)}))
    },
    exportBytes(expected,signal) {
      return enqueue(expected,signal,async state=>{
        const bytes=await savePptx(state)
        check(expected,signal)
        // Download bytes only. Never calls commitSaved or marks a durable revision as saved.
        return {generation,bytes}
      })
    },
    close() {
      if (opened) { opened=undefined; undoStack.length=0; undoBytes=0; redoStack.length=0; redoBytes=0 }
    },
  }
}

// ── child-process IPC loop: one untrusted deck per isolated Node child ──

export interface PptxChildBinding { fileId: string; revision: string }
interface ChildMessage { id: number; m: string; expected?: number; ops?: unknown; slide?: number; width?: number; bytes?: Uint8Array; binding?: PptxChildBinding }
/** Child entry body: serves exactly one bound session over IPC, then exits. Exported for the
 * dedicated child entry module; never starts from an imported module by accident. */
export function runPptxSessionChild(): void {
  if (!process.send) throw new Error('PPTX session child requires an IPC channel')
  let binding: PptxChildBinding | undefined, session: PptxSession | undefined
  const reply=(id:number,payload:unknown)=>{ process.send!(payload) }
  process.on('message',(raw: ChildMessage)=>{
    void (async()=>{
      const {id,m}=raw
      try {
        if (m==='open') {
          if (session) throw new Error('ALREADY_OPEN')
          if (!raw.binding?.fileId || !raw.binding.revision || !(raw.bytes instanceof Uint8Array)) throw new Error('INVALID_OPEN')
          binding=raw.binding
          session=await createPptxSession(raw.bytes)
          const outline=await session.outline(0)
          reply(id,{id,ok:true,result:{count:outline.count,size:outline.size}})
          return
        }
        if (!session || !binding) throw new Error('SESSION_CLOSED')
        if (raw.binding && (raw.binding.fileId!==binding.fileId || raw.binding.revision!==binding.revision)) throw new Error('BINDING_CONFLICT')
        switch (m) {
          case 'apply': reply(id,{id,ok:true,result:await session.apply(raw.expected!,raw.ops)}); return
          case 'undo': reply(id,{id,ok:true,result:await session.undo(raw.expected!)}); return
          case 'redo': reply(id,{id,ok:true,result:await session.redo(raw.expected!)}); return
          case 'render': reply(id,{id,ok:true,result:await session.render(raw.expected!,raw.slide!,raw.width)}); return
          case 'renderAll': reply(id,{id,ok:true,result:await session.renderAll(raw.expected!,raw.width)}); return
          case 'outline': reply(id,{id,ok:true,result:await session.outline(raw.expected!)}); return
          case 'export': reply(id,{id,ok:true,result:await session.exportBytes(raw.expected!)}); return
          case 'close': reply(id,{id,ok:true,result:true}); session.close(); process.exit(0); return
          default: throw new Error('UNSUPPORTED_METHOD')
        }
      } catch (error) {
        reply(id,{id,ok:false,error: error instanceof Error ? error.message : String(error)})
        if (m==='open' && session) { session.close(); session=undefined }
      }
    })()
  })
  process.on('disconnect',()=>{ session?.close(); process.exit(0) })
}
