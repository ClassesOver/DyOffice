import {safeExternalUrl} from '../../../../../packages/electron-utils/src/safe-external-url'
import type {AnimationItem,RunLink} from './pptx-session-host'
import {getRunLinks,MAX_INSERT_TABLE_DIM,NAMED_ACTIONS} from '@genoffice/pptx-engine'
import type {LinkTarget as LinkTargetOp} from '@genoffice/pptx-engine'
import { openPptx, savePptx, getChartElementData, getSlideLinks, getSlideAnimations, elementSpid, parseTheme, getSlideNotes, getSlideComments, materializeSlide, listSlideLayouts, builtinLayoutInfos, shouldOfferBuiltinLayouts, type OpenedPptx, type Slide, type SlideSize, type SlideComment } from '@genoffice/pptx-engine'
import { matchesElementRef } from '@genoffice/pptx-engine/identity'
import { runTxn, elementDurableId, slideDurableId, type Op, type OpRecord } from '@genoffice/pptx-ops'
import { markChartEditable } from '@genoffice/pptx-engine'
import { buildRenderSlide, imageSizeFromBytes, type RenderSlide } from '@genoffice/pptx-render'
import { coverCropFractions } from '@genoffice/pipelines/slides'
import { buildPagePptx, parsePageSpec } from '@genoffice/pipelines/slides'
import { extractMergeSlideSource, type MergeSlideSource } from '@genoffice/pptx-engine'
import { assertZipInflatesWithinLimits } from '@genoffice/zip-gate'
import { randomUUID } from 'node:crypto'
import type { SlidesImageCommand, SlidesApplyView } from './pptx-session-host.ts'

/** In-process reuse seam, NOT an authenticated service, durable revision ledger or sandbox.
 * No network, filesystem paths, global session registry or persistent save acknowledgements.
 * Caller must close handles and provide isolation/quotas before any untrusted deployment.
 *
 * Isolation: untrusted PPTX bytes are parsed and mutated ONLY inside createPptxSession.
 * The test-only openIsolatedPptxSession factory hosts one session per forked Node child
 * process, so uploaded packages never touch the API process heap; payloads stay bounded by
 * MAX_INPUT/MAX_PAYLOAD/ZIP_LIMITS below and every handle is bound to one file/revision.
 */
export type { RenderSlide } from '@genoffice/pptx-render'
export interface SlidesCreatedEntry { slide: number; index: number; id: string }
export interface SlidesApplyResult {
  generation: number; stateGeneration: number; canUndo: boolean; canRedo: boolean
  records: OpRecord[]; slideIds: string[]; paths: string[]; created: SlidesCreatedEntry[]
  transaction: { applied: boolean; dryRun?: boolean; plan?: string[]; failures?: Array<{ index: number; error: string }>; records?: Array<{op:{op:string};slideId?:string;created?:string[]}> }
}
export interface SlidesStepResult { generation: number; stateGeneration: number; canUndo: boolean; canRedo: boolean; slides: RenderSlide[] }
export interface SlidesOutline { count: number; size: SlideSize; slideIds: string[]; paths: string[]; defaultFont?: string }
export interface PptxSelection {
  generation: number
  slide: {index: number; id: string | undefined}
  element?: {id: string; type: string}
}
export interface PptxSession {
  selection(expectedGeneration: number, slide: number, elementId?: string, signal?: AbortSignal): Promise<PptxSelection>
  apply(expectedGeneration: number, ops: unknown, signal?: AbortSignal, options?: { isolation?: 'atomic' | 'per_op'; dryRun?: boolean }): Promise<SlidesApplyResult>
  editChart(expectedGeneration:number,slide:number,sourceId:string,patch:Record<string,unknown>,signal?:AbortSignal):Promise<{generation:number;stateGeneration:number;canUndo:boolean;canRedo:boolean;slide:RenderSlide;sourceId:string}>
  generatePage(expectedGeneration:number,specJson:string,images:Array<{url:string;bytes:Uint8Array;ext:string}>,signal?:AbortSignal):Promise<{marker:string;imageFailures:string[];imageWarnings:string[]}>
  landGeneratedPages(expectedGeneration:number,markers:string[],mode:'replace'|'append'|'replace_at'|'insert_at',atIndex?:number,signal?:AbortSignal):Promise<SlidesApplyResult>
  undo(expectedGeneration: number, signal?: AbortSignal): Promise<SlidesStepResult>
  redo(expectedGeneration: number, signal?: AbortSignal): Promise<SlidesStepResult>
  beginHistoryBatch(expectedGeneration:number,signal?:AbortSignal):Promise<boolean>
  endHistoryBatch(expectedGeneration:number,signal?:AbortSignal):Promise<{snapshotId:number|null;canUndo:boolean;canRedo:boolean}>
  restoreSnapshot(expectedGeneration:number,snapshotId:number,signal?:AbortSignal):Promise<SlidesStepResult|null>
  render(expectedGeneration: number, slide: number, fitWidthPx?: number, signal?: AbortSignal): Promise<RenderSlide>
  chartData(expectedGeneration:number,slide:number,sourceId:string,signal?:AbortSignal):Promise<ReturnType<typeof import('@genoffice/pptx-engine').getChartElementData>>
  chartColorSchemes(expectedGeneration:number,signal?:AbortSignal):Promise<Array<{key:string;colors:string[]}>>
  animations(expectedGeneration:number,slide:number,signal?:AbortSignal):Promise<AnimationItem[]>
  links(expectedGeneration:number,slide:number,signal?:AbortSignal):Promise<Array<{sourceId:string;target:LinkTargetOp}>>
  runLinks(expectedGeneration:number,slide:number,signal?:AbortSignal):Promise<RunLink[]>
  notes(expectedGeneration: number, slide: number, signal?: AbortSignal): Promise<string>
  comments(expectedGeneration: number, slide: number, signal?: AbortSignal): Promise<SlideComment[]>
  layouts(expectedGeneration: number, signal?: AbortSignal): Promise<{layouts: ReturnType<typeof listSlideLayouts>; size: SlideSize}>
  renderAll(expectedGeneration: number, fitWidthPx?: number, signal?: AbortSignal): Promise<RenderSlide[]>
  outline(expectedGeneration: number, signal?: AbortSignal): Promise<SlidesOutline>
  exportBytes(expectedGeneration: number, signal?: AbortSignal): Promise<{generation:number;bytes:Uint8Array}>
  applyImage(expectedGeneration:number,input:SlidesImageCommand,signal?:AbortSignal):Promise<SlidesApplyView>
  close(): void
}
const DECK_LINK_PROTOCOLS=['http:','https:','mailto:'] as const
const MAX_INPUT = 32 * 1024 * 1024
const MAX_PAYLOAD = 256 * 1024
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const ZIP_LIMITS = {maxParts:1500, maxPartBytes:8*1024*1024, maxTotalBytes:64*1024*1024}
// Undo history is whole-deck snapshots (slides deep, archive entries shallow): bound both the
// count and the estimated retained bytes so a hostile deck cannot grow the session without limit.
const MAX_HISTORY = 8, MAX_HISTORY_BYTES = 16 * 1024 * 1024
const MAX_RENDER_SLIDES = 200
const MAX_GENERATED_BYTES=64*1024*1024,MAX_GENERATED_PAGES=200
const MIN_FIT_WIDTH_PX = 320, MAX_FIT_WIDTH_PX = 4096, DEFAULT_FIT_WIDTH_PX = 960
const EMU_MAX = 2147483647, ROT_DEG_MAX = 35791
function imageContent(input:SlidesImageCommand){
  if(!input||typeof input!=='object'||(input.mode!=='insert'&&input.mode!=='replace')||!(input.bytes instanceof Uint8Array)||input.bytes.byteLength<1||input.bytes.byteLength>MAX_IMAGE_BYTES)throw new Error('INVALID_MEDIA')
  const bytes=Uint8Array.from(input.bytes)
  const mime=bytes[0]===0x89&&bytes[1]===0x50&&bytes[2]===0x4e&&bytes[3]===0x47?'image/png'
    :bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff?'image/jpeg'
    :bytes[0]===0x47&&bytes[1]===0x49&&bytes[2]===0x46&&bytes[3]===0x38?'image/gif':null
  const ext=String(input.ext).toLowerCase().replace(/^jpeg$/,'jpg')
  if(!mime||({png:'image/png',jpg:'image/jpeg',gif:'image/gif'} as Record<string,string>)[ext]!==mime)throw new Error('INVALID_MEDIA')
  const size=mime==='image/gif'&&bytes.length>=10?{w:bytes[6]!+(bytes[7]!<<8),h:bytes[8]!+(bytes[9]!<<8)}:imageSizeFromBytes(bytes)
  if(!size||size.w<1||size.h<1||size.w>100_000||size.h>100_000||size.w*size.h>100_000_000)throw new Error('INVALID_MEDIA')
  return {bytes,ext,size}
}
/** JSON-only surface for GenOffice's AI-callable ops. Media-bearing and explicitly
 * non-AI-callable ops stay out; every accepted op is revalidated by the op registry. */
const OP_FIELDS: Record<string, readonly string[]> = {
  setText: ['op','target','paragraphs','group'],
  setFill: ['op','target','fill','group'],
  setStroke: ['op','target','stroke','group'],
  addElement: ['op','target','offset','kind','paragraphs','fill','stroke','bodyPr','adjustments'],
  deleteElement: ['op','target'],
  setTransform: ['op','target','box','absBox','rotDeg','group','resizeTableGrid'],
  reorderElement: ['op','target','dir'],
  groupElements: ['op','target','els'],
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
  setSlideLayout: ['op','target','layout','layoutPath'],
  applyHeaderFooter: ['op','settings'],
  setTransition: ['op','target','kind'],
  setHidden: ['op','target','hidden'],
  setSections: ['op','sections'],
  addSection: ['op','atSlideIndex','name'],
  renameSection: ['op','id','name'],
  removeSection: ['op','id'],
  moveSection: ['op','id','dir'],
  setShapeGeometry: ['op','target','prst','group'],
  flipElements: ['op','target','els','axis','group'],
  setShapeAdjust: ['op','target','adjust','group'],
  setTextAnchor: ['op','target','anchor','group'],
  setTextBodyProps: ['op','target','props','group'],
  setEffects: ['op','target','effects','group'],
  addTable: ['op','target','offset','rows','cols','cells','styleId','colWidthsEmu','rowHeightsEmu','cellProps'],
  setTableCell: ['op','target','row','col','paragraphs'],
  tableStructure: ['op','target','kind','index','before'],
  tableMerge: ['op','target','kind','row','col'],
  setTableColWidth: ['op','target','col','wEmu'],
  setTableRowHeight: ['op','target','row','hEmu'],
  setTableCellAnchor: ['op','target','row','col','anchor'],
  setTableStyle: ['op','target','styleName','styleId','firstRow','lastRow','firstCol','lastCol','bandRow','bandCol','rtl','shadingColor','borderColor','borderWidthPt','borderPreset','cells','keepFormatting'],
  setBackground: ['op','target','kind','color','from','to','angleDeg','radial','hidden'],
  setPictureSrcRect: ['op','target','srcRect','box'],
  setPictureOpacity: ['op','target','opacity'],
  addChart: ['op','target','kind','barDir','title','categories','series','offset','colorScheme','holeSizePct'],
  addSmartArt: ['op','target','layout','items','offset'],
  setLink: ['op','target','link'],
  setAdvanceTime: ['op','target','ms'],
  setAnimations: ['op','target','items'],
  addAnimation: ['op','target','effect','kind','trigger','duration','delay','direction','paragraph','motionPath','presetXml','after'],
  removeAnimation: ['op','target','seq'],
  reorderAnimation: ['op','target','seq','to'],
  addConnector: ['op','target','from','to','kind','fromSide','toSide','arrow','line'],
  setConnectorEndpoints: ['op','target','p1','p2','start','end'],
  setSlideSize: ['op','cx','cy'],
  alignElements: ['op','target','els','mode','to'],
  distributeElements: ['op','target','els','axis','to'],
  insertEquation: ['op','target','latex','position','box'],
  applyTheme: ['op','name','colors','majorFont','minorFont'],
  setRedaction: ['op','target','label'],
  setShapeCustomGeometry: ['op','target','path','group'],
  addComment: ['op','target','text','author'],
  deleteComment: ['op','target','authorId','idx'],
}
const ADDING_SLIDES = new Set(['addBlankSlide','addSlideWithLayout','duplicateSlide','insertSlidePptx'])
const PARAGRAPH_KEYS = ['runs','align','level','srcPara','bullet','bulletChar','lineSpacingPct','spaceBeforePt','spaceAfterPt','rtl']
const RUN_KEYS = ['text','bold','italic','underline','strike','fontSize','fontFamily','color','baseline','srcRun','link','redact']
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
  keys(value, ['stops','angle','radial','path'])
  gradientStops(value.stops, 'INVALID_FILL')
  if (value.angle !== undefined) angle(value.angle, 'INVALID_FILL')
  if (value.radial !== undefined && typeof value.radial !== 'boolean') throw new Error('INVALID_FILL')
  if (value.path !== undefined && !['circle','rect','shape'].some(path=>path===value.path)) throw new Error('INVALID_FILL')
}
function checkStrokePatch(value: unknown, allowGradient: boolean) {
  if (value === null) { if (allowGradient) return; throw new Error('INVALID_STROKE') }
  if (!record(value)) throw new Error('INVALID_STROKE')
  keys(value, allowGradient ? ['color','widthEmu','dash','gradient','cap','join','compound'] : ['color','widthEmu','dash'])
  if (!isHexColor(value.color)) throw new Error('INVALID_STROKE')
  if (typeof value.widthEmu !== 'number' || !Number.isFinite(value.widthEmu) || (value.widthEmu as number) <= 0 || (value.widthEmu as number) > EMU_MAX) throw new Error('INVALID_STROKE')
  if (value.dash !== undefined && (typeof value.dash !== 'string' || !value.dash || value.dash.length > 32)) throw new Error('INVALID_STROKE')
  for (const [field, allowed] of Object.entries({cap:['flat','rnd','sq'],join:['round','bevel','miter'],compound:['sng','dbl','thickThin','thinThick','tri']})) {
    if (value[field] !== undefined && !allowed.some(item=>item===value[field])) throw new Error('INVALID_STROKE')
  }
  if (value.gradient !== undefined) {
    if (!allowGradient || !record(value.gradient)) throw new Error('INVALID_STROKE')
    keys(value.gradient, ['stops','angle'])
    gradientStops(value.gradient.stops, 'INVALID_STROKE')
    if (value.gradient.angle !== undefined) angle(value.gradient.angle, 'INVALID_STROKE')
  }
}
function checkRunLink(value: unknown) {
  if (!record(value)) throw new Error('INVALID_RUN')
  if (value.kind === 'url') {
    keys(value,['kind','url'])
    if (safeExternalUrl(value.url,{allowedProtocols:DECK_LINK_PROTOCOLS}) !== null) return
  } else if (value.kind === 'slide') {
    keys(value,['kind','slideIndex'])
    if (Number.isSafeInteger(value.slideIndex) && (value.slideIndex as number) >= 0) return
  } else if (value.kind === 'action') {
    keys(value,['kind','action'])
    if ((NAMED_ACTIONS as readonly unknown[]).includes(value.action)) return
  }
  throw new Error('INVALID_RUN')
}
function checkParagraphs(value: unknown) {
  if (!Array.isArray(value) || value.length > 1000) throw new Error('INVALID_PARAGRAPHS')
  for (const paragraph of value) {
    if (!record(paragraph)) throw new Error('INVALID_PARAGRAPHS')
    keys(paragraph, PARAGRAPH_KEYS)
    if (paragraph.align !== undefined && !['left','center','right','justify'].includes(paragraph.align as string)) throw new Error('INVALID_PARAGRAPHS')
    if (paragraph.level !== undefined && (!Number.isSafeInteger(paragraph.level) || (paragraph.level as number) < 0 || (paragraph.level as number) > 8)) throw new Error('INVALID_PARAGRAPHS')
    if (paragraph.srcPara !== undefined && (!Number.isSafeInteger(paragraph.srcPara) || (paragraph.srcPara as number) < 0)) throw new Error('INVALID_PARAGRAPHS')
    if (paragraph.bullet !== undefined && !['char','number','none'].some(kind=>kind===paragraph.bullet)) throw new Error('INVALID_PARAGRAPHS')
    if (paragraph.bulletChar !== undefined && (typeof paragraph.bulletChar !== 'string' || Array.from(paragraph.bulletChar).length !== 1)) throw new Error('INVALID_PARAGRAPHS')
    if (paragraph.rtl !== undefined && typeof paragraph.rtl !== 'boolean') throw new Error('INVALID_PARAGRAPHS')
    for (const [field,max] of Object.entries({lineSpacingPct:13200,spaceBeforePt:1584,spaceAfterPt:1584})) {
      const amount=paragraph[field]
      if (amount!==undefined&&(typeof amount!=='number'||!Number.isFinite(amount)||amount<0||amount>max)) throw new Error('INVALID_PARAGRAPHS')
    }
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
      if (run.link != null) checkRunLink(run.link)
      if (run.redact != null && typeof run.redact !== 'string') throw new Error('INVALID_RUN')
    }
  }
}
function checkTableGrid(value: Record<string,unknown>) {
  const {rows,cols,cellProps}=value
  if(typeof rows!=='number'||typeof cols!=='number'||![rows,cols].every(n=>Number.isSafeInteger(n)&&n>=1&&n<=MAX_INSERT_TABLE_DIM))throw new Error('INVALID_TABLE')
  for(const [length,dimensions] of [[cols,value.colWidthsEmu],[rows,value.rowHeightsEmu]] as const){
    if(dimensions!==undefined&&(!Array.isArray(dimensions)||dimensions.length!==length||dimensions.some(n=>!emu(n)||n<=0)))throw new Error('INVALID_TABLE')
  }
  if(cellProps===undefined)return
  if(!Array.isArray(cellProps)||cellProps.length>rows)throw new Error('INVALID_TABLE')
  for(const [r,row] of cellProps.entries()){
    if(row==null)continue
    if(!Array.isArray(row)||row.length>cols)throw new Error('INVALID_TABLE')
    for(const [c,cell] of row.entries()){
      if(cell==null)continue
      if(!record(cell))throw new Error('INVALID_TABLE')
      keys(cell,['gridSpan','rowSpan','hMerge','vMerge','anchor'])
      for(const [span,max] of [[cell.gridSpan,cols-c],[cell.rowSpan,rows-r]] as const){
        if(span!==undefined&&(typeof span!=='number'||!Number.isSafeInteger(span)||span<1||span>max))throw new Error('INVALID_TABLE')
      }
      if((cell.hMerge!==undefined&&typeof cell.hMerge!=='boolean')||(cell.vMerge!==undefined&&typeof cell.vMerge!=='boolean')||
       (cell.anchor!==undefined&&!['t','ctr','b'].some(anchor=>anchor===cell.anchor)))throw new Error('INVALID_TABLE')
    }
  }
}
function checkLayoutRef(value: unknown) {
  if (Number.isSafeInteger(value) && (value as number) >= 0) return
  if (typeof value === 'string' && value.length > 0 && value.length <= 512 && /^[\w./ -]+$/.test(value)) return
  throw new Error('INVALID_LAYOUT')
}
/** JSON-only command surface. Never forward TxnRequest.parts, master-part targets, media bytes
 * or arbitrary op names: each op is field-checked against the whitelist above, then re-validated
 * and journaled by the op registry inside the selected transaction mode. */
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
      case 'setLink':
        if(record(value.link)&&value.link.kind==='url'&&safeExternalUrl(value.link.url,{allowedProtocols:DECK_LINK_PROTOCOLS})===null)throw new Error('INVALID_LINK')
        break
      case 'setAnimations':
        if(!Array.isArray(value.items)||value.items.length>200)throw new Error('INVALID_ANIMATIONS')
        for(const item of value.items){
          if(!record(item))throw new Error('INVALID_ANIMATIONS')
          keys(item,['sourceId','effect','trigger','durationMs','delayMs','motionPath','paragraph','direction'])
          if(item.motionPath!==undefined&&(typeof item.motionPath!=='string'||item.motionPath.length>16384))throw new Error('INVALID_ANIMATIONS')
          if(item.paragraph!==undefined&&(!Number.isSafeInteger(item.paragraph)||(item.paragraph as number)<0))throw new Error('INVALID_ANIMATIONS')
        }
        break
      case 'setText':
      case 'setTableCell':
        checkParagraphs(value.paragraphs)
        break
      case 'addTable':
        checkTableGrid(value)
        break
      case 'setTableStyle':
        if(value.keepFormatting!==undefined&&typeof value.keepFormatting!=='boolean')throw new Error('INVALID_TABLE')
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
        if (value.adjustments !== undefined && (!record(value.adjustments) || Object.entries(value.adjustments).some(([name, amount]) => !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) || !emu(amount)))) throw new Error('INVALID_GEOMETRY')
        break
      case 'setTransform':
        if(value.resizeTableGrid!==undefined&&typeof value.resizeTableGrid!=='boolean')throw new Error('INVALID_GEOMETRY')
        if (value.absBox !== undefined) {
          if (!value.group || value.box !== undefined) throw new Error('UNSUPPORTED_FIELD')
          geometry(value.absBox, 'INVALID_GEOMETRY')
        } else geometry(value.box, 'INVALID_GEOMETRY')
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
function historyCost(state: OpenedPptx): number {
  // Conservative logical retained size, not a promise about V8 heap/RSS. Archive buffers
  // shared between snapshots are deliberately charged once per snapshot.
  let bytes = new TextEncoder().encode(JSON.stringify(state.deck.slides)).byteLength
  for (const [path, buffer] of state.archive.entries) bytes += path.length * 2 + buffer.byteLength
  if (bytes > MAX_HISTORY_BYTES) throw new Error('HISTORY_LIMIT')
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
function chartColors(state:OpenedPptx,key:string):string[]|undefined{
  const legacy:Record<string,string[]>={blue:['#2E75B6','#4472C4','#5B9BD5','#70AD47','#ED7D31'],warm:['#ED7D31','#FFC000','#FF0000','#C55A11','#833C00'],cool:['#0070C0','#00B0F0','#00B0A0','#7030A0','#2E75B6'],mono:['#404040','#666666','#888888','#AAAAAA','#CCCCCC']}
  if(legacy[key])return legacy[key]
  const slide=state.deck.slides[0]
  let accents:string[]=[]
  try{const chain=slide&&state.archive.resolveSlideChain(slide.path);const xml=chain?.themePath?state.archive.readText(chain.themePath):null;const colors=xml?parseTheme(xml).colors:undefined;accents=['accent1','accent2','accent3','accent4','accent5','accent6'].map(name=>colors?.[name]).filter((color):color is string=>!!color)}catch{}
  if(accents.length<3)accents=['#4472C4','#ED7D31','#A5A5A5','#FFC000','#5B9BD5','#70AD47']
  if(key==='default')return []
  if(key==='colorful')return accents
  if(key==='colorful2')return [...accents.slice(3),...accents.slice(0,3)]
  const match=/^mono-accent([1-6])$/.exec(key)
  if(!match)return undefined
  const color=accents[Number(match[1])-1]!
  const mix=(target:number,ratio:number)=>{const value=parseInt(color.slice(1),16),channel=(part:number)=>Math.round(part+(target-part)*ratio);return '#'+((channel(value>>16)<<16)|(channel((value>>8)&255)<<8)|channel(value&255)).toString(16).padStart(6,'0').toUpperCase()}
  return [mix(0,.25),color,mix(255,.25),mix(255,.45),mix(255,.65)]
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
  const generatedPages=new Map<string,{source:MergeSlideSource;bytes:number;size:SlideSize}>()
  let generatedBytes=0
  // The generation whose exact state the deck currently holds; a deck restored by undo/redo
  // maps back to the snapshot's pre-edit generation, which drives the caller's dirty tracking.
  let stateGeneration=0
  let queue: Promise<unknown>=Promise.resolve()
  let pending=0
  const undoStack: HistorySnapshot[]=[]; let undoBytes=0
  const redoStack: HistorySnapshot[]=[]; let redoBytes=0
  let batchDepth=0,batchBefore:HistorySnapshot|undefined,nextSnapshotId=0,aiSnapshotBytes=0
  const aiSnapshots=new Map<number,HistorySnapshot>()
  function snapshot(state: OpenedPptx): HistorySnapshot {
    const bytes=historyCost(state)
    const slides=structuredClone(state.deck.slides)
    return { slides, size: {cx: state.deck.size.cx, cy: state.deck.size.cy}, entries: new Map(state.archive.entries), bytes, atGeneration: stateGeneration }
  }
  function restore(state: OpenedPptx, snap: HistorySnapshot): void {
    // Undo and AI checkpoints can share a snapshot; the live deck must own its model.
    state.deck.slides=structuredClone(snap.slides)
    state.deck.size={...snap.size}
    const entries=state.archive.entries
    entries.clear()
    for (const [path,buffer] of snap.entries) entries.set(path,buffer)
    stateGeneration=snap.atGeneration
  }
  function push(stack: HistorySnapshot[], snap: HistorySnapshot) {
    if(stack===undoStack&&batchDepth>0)return
    stack.push(snap)
    if (stack === undoStack) undoBytes += snap.bytes
    else redoBytes += snap.bytes
    // Keep the nearest transitions; evict the far end of the opposite stack first.
    while (undoStack.length + redoStack.length > MAX_HISTORY || undoBytes + redoBytes > MAX_HISTORY_BYTES) {
      const victim = stack === undoStack
        ? (redoStack.length ? redoStack : undoStack)
        : (undoStack.length ? undoStack : redoStack)
      const dropped = victim.shift()!
      if (victim === undoStack) undoBytes -= dropped.bytes
      else redoBytes -= dropped.bytes
    }
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
  function mediaResolver(state: OpenedPptx) {
    return (mediaRef: string): string | undefined => {
      const bytes = state.archive.readBytes(mediaRef)
      if (!bytes || bytes.byteLength === 0 || bytes.byteLength > 8 * 1024 * 1024) return undefined
      const ext = mediaRef.split('.').pop()?.toLowerCase() ?? ''
      const mime = bytes[0] === 0x89 && bytes[1] === 0x50 ? 'image/png'
        : bytes[0] === 0xff && bytes[1] === 0xd8 ? 'image/jpeg'
        : bytes[0] === 0x47 && bytes[1] === 0x49 ? 'image/gif'
        : ({png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',bmp:'image/bmp',svg:'image/svg+xml'} as Record<string,string>)[ext]
      if (!mime) return undefined
      return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`
    }
  }
  function renderSlides(state: OpenedPptx, width: number): RenderSlide[] {
    if (state.deck.slides.length>MAX_RENDER_SLIDES) throw new Error('RENDER_LIMIT')
    const media = mediaResolver(state)
    return state.deck.slides.map((slide,index)=>structuredClone(buildRenderSlide(slide,state.deck.size,{fitWidthPx:width,slideNo:index+1,media})))
  }
  return {
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
    async apply(expected, ops, signal, options = {}) {
      const captured=captureOps(ops)
      return enqueue(expected,signal,state=>{
        // Preserve target's canonical/parse-time alias collision fence for every
        // element-addressed operation before the atomic batch can mutate anything.
        for (const op of captured) {
          if (!op.target || typeof op.target.el !== 'string') continue
          const slide = state.deck.slides[op.target.slide as number]
          if (slide && slide.elements.filter(e => matchesElementRef(e, op.target!.el as string)).length > 1) throw new Error('AMBIGUOUS_ELEMENT')
        }
        const before=snapshot(state)
        let result: ReturnType<typeof runTxn>
        try {
          result=runTxn(state,{isolation: options.isolation ?? 'atomic', dryRun: options.dryRun, ops:captured})
          if (!options.dryRun && result.applied) historyCost(state) // Every accepted state must remain snapshot-able for undo.
        } catch (error) { restore(state,before); throw error }
        if (!options.dryRun && result.applied) {
          redoStack.length=0; redoBytes=0
          push(undoStack,before)
          generation++
          stateGeneration=generation
        }
        const journal=(result.records ?? []).map(record=>({op:{op:record.op.op},...(record.slideId ? {slideId:record.slideId} : {}),...(record.created ? {created:record.created} : {})}))
        return {generation,stateGeneration,...history(),records:result.records ?? [],...outlineOf(state),created:createdOf(state,result.records ?? []),transaction:{applied:result.applied,...(result.dryRun ? {dryRun:true} : {}),...(result.plan ? {plan:result.plan} : {}),...(result.failures ? {failures:result.failures.map(({index,error})=>({index,error}))} : {}),...(result.records ? {records:journal} : {})}}
      })
    },
    async editChart(expected,slideIndex,sourceId,patch,signal) {
      return enqueue(expected,signal,state=>{
        if(!Number.isSafeInteger(slideIndex)||slideIndex<0||slideIndex>=state.deck.slides.length)throw new Error('INVALID_SLIDE')
        if(typeof sourceId!=='string'||!sourceId||sourceId.length>256||!record(patch))throw new Error('INVALID_OPS')
        const slide=state.deck.slides[slideIndex]!
        if(slide.elements.filter(element=>matchesElementRef(element,sourceId)).length!==1)throw new Error('INVALID_ELEMENT')
        const element=slide.elements.find(element=>matchesElementRef(element,sourceId))
        if(element?.type!=='chart')throw new Error('INVALID_ELEMENT')
        const elementIndex=slide.elements.indexOf(element)
        const before=snapshot(state)
        try{
          if(!markChartEditable(slide,element.id))throw new Error('INVALID_ELEMENT')
          const normalized={...patch,...(typeof patch.kind==='string'&&patch.kind==='barH'?{kind:'bar',barDir:'bar'}:{}),...(typeof patch.colorScheme==='string'?{colorScheme:chartColors(state,patch.colorScheme)}:{})}
          if(typeof patch.colorScheme==='string'&&!normalized.colorScheme)throw new Error('INVALID_OPS')
          const result=runTxn(state,{isolation:'atomic',ops:[{op:'setChart',target:{slide:slideIndex,el:element.id},patch:normalized} as Op]})
          if(!result.applied)throw new Error('OP_REJECTED')
          const rebuilt=materializeSlide(state,slideIndex)
          const refreshed=rebuilt?.elements[elementIndex]
          if(refreshed?.type!=='chart')throw new Error('OP_REJECTED')
          historyCost(state)
          redoStack.length=0;redoBytes=0;push(undoStack,before)
          generation++;stateGeneration=generation
          return {generation,stateGeneration,...history(),slide:structuredClone(buildRenderSlide(state.deck.slides[slideIndex]!,state.deck.size,{fitWidthPx:DEFAULT_FIT_WIDTH_PX,slideNo:slideIndex+1,media:mediaResolver(state)})),sourceId:refreshed.id}
        }catch(error){restore(state,before);throw error}
      })
    },
    async generatePage(expected,specJson,images,signal){
      return enqueue(expected,signal,async state=>{
        if(typeof specJson!=='string'||specJson.length>MAX_PAYLOAD||!Array.isArray(images)||images.length>3)throw new Error('INVALID_GENERATED_PAGE')
        const parsed=parsePageSpec(specJson,1280,720)
        if(!parsed.ok)throw new Error('INVALID_GENERATED_PAGE')
        const imageMap=new Map<string,{bytes:Uint8Array;ext:string}>()
        let imageBytes=0
        for(const image of images){
          if(!image||typeof image.url!=='string'||image.url.length>4096||imageMap.has(image.url)||!(image.bytes instanceof Uint8Array)||image.bytes.byteLength<1||image.bytes.byteLength>MAX_IMAGE_BYTES)throw new Error('INVALID_MEDIA')
          const media=imageContent({mode:'insert',slide:0,offset:{x:0,y:0,cx:1,cy:1},bytes:image.bytes,ext:image.ext})
          imageBytes+=media.bytes.byteLength
          if(imageBytes>15*1024*1024)throw new Error('INVALID_MEDIA')
          imageMap.set(image.url,{bytes:media.bytes,ext:media.ext})
        }
        const built=await buildPagePptx(parsed.spec,{fetchImage:async url=>imageMap.get(url)??null,imageDims:bytes=>{const size=imageSizeFromBytes(bytes);return size?{width:size.w,height:size.h}:null}})
        const source=await extractMergeSlideSource(built.bytes)
        if(!source)throw new Error('INVALID_GENERATED_PAGE')
        const cost=new TextEncoder().encode(source.slideXml).byteLength+source.media.reduce((sum,item)=>sum+item.bytes.byteLength,0)+source.layoutChain.reduce((sum,item)=>sum+item.bytes.byteLength,0)
        if(generatedPages.size>=MAX_GENERATED_PAGES||generatedBytes+cost>MAX_GENERATED_BYTES)throw new Error('GENERATED_PAGE_LIMIT')
        const marker='webpptx:'+randomUUID()
        generatedPages.set(marker,{source,bytes:cost,size:built.size});generatedBytes+=cost
        return {marker,imageFailures:built.imageFailures,imageWarnings:[...parsed.warnings,...built.imageWarnings]}
      })
    },
    async landGeneratedPages(expected,markers,mode,atIndex,signal){
      return enqueue(expected,signal,state=>{
        if(!Array.isArray(markers)||!markers.length||markers.length>MAX_GENERATED_PAGES||!['replace','append','replace_at','insert_at'].includes(mode))throw new Error('INVALID_GENERATED_PAGE')
        if((mode==='replace_at'||mode==='insert_at')&&(
          markers.length!==1||!Number.isSafeInteger(atIndex)||atIndex!<0||
          atIndex!>(mode==='replace_at'?state.deck.slides.length-1:state.deck.slides.length)
        ))throw new Error('INVALID_GENERATED_PAGE')
        const resultingCount=mode==='replace'?markers.length:state.deck.slides.length+(mode==='replace_at'?0:markers.length)
        if(resultingCount>MAX_RENDER_SLIDES)throw new Error('RENDER_LIMIT')
        const pages=markers.map(marker=>typeof marker==='string'?generatedPages.get(marker):undefined)
        if(pages.some(page=>!page))throw new Error('INVALID_GENERATED_PAGE')
        const sources=pages.map(page=>page!.source)
        const ops:Op[]=[]
        if(mode==='replace'){
          const {cx,cy}=pages[0]!.size
          if(state.deck.size.cx!==cx||state.deck.size.cy!==cy)ops.push({op:'setSlideSize',cx,cy})
          ops.push({op:'insertSlidePptx',target:{slide:0},source:sources[0],at:0,replace:true} as Op)
          for(let index=state.deck.slides.length-1;index>=1;index--)ops.push({op:'deleteSlide',target:{slide:index}})
          for(const source of sources.slice(1))ops.push({op:'insertSlidePptx',target:{slide:0},source} as Op)
        }else if(mode==='replace_at')ops.push({op:'insertSlidePptx',target:{slide:0},source:sources[0],at:atIndex,replace:true} as Op)
        else for(let index=0;index<sources.length;index++)ops.push({op:'insertSlidePptx',target:{slide:0},source:sources[index],at:mode==='insert_at'?atIndex!+index:undefined} as Op)
        const before=snapshot(state)
        let result:ReturnType<typeof runTxn>
        try{result=runTxn(state,{isolation:'atomic',ops});if(!result.applied)throw new Error(result.failures?.[0]?.error??'OP_REJECTED');historyCost(state)}catch(error){restore(state,before);throw error}
        redoStack.length=0;redoBytes=0;push(undoStack,before);generation++;stateGeneration=generation
        for(const marker of markers){const page=generatedPages.get(marker);if(page){generatedBytes-=page.bytes;generatedPages.delete(marker)}}
        const journal=(result.records??[]).map(record=>({op:{op:record.op.op},...(record.slideId?{slideId:record.slideId}:{}),...(record.created?{created:record.created}:{})}))
        return {generation,stateGeneration,...history(),records:result.records??[],...outlineOf(state),created:createdOf(state,result.records??[]),transaction:{applied:true,records:journal}}
      })
    },
    async applyImage(expected,input,signal){
      const media=imageContent(input)
      return enqueue(expected,signal,state=>{
        if(!Number.isSafeInteger(input.slide)||input.slide<0||input.slide>=state.deck.slides.length)throw new Error('INVALID_SLIDE')
        const slide=state.deck.slides[input.slide]!
        let offset:{x:number;y:number;cx:number;cy:number}|undefined
        let targetId:string|undefined
        if(input.mode==='insert'){
          const value=input.offset
          if(!value||![value.x,value.y,value.cx,value.cy].every(Number.isFinite)||value.cx<=0||value.cy<=0||[value.x,value.y,value.cx,value.cy].some(n=>Math.abs(n)>EMU_MAX))throw new Error('INVALID_GEOMETRY')
          offset={x:Math.round(value.x),y:Math.round(value.y),cx:Math.round(value.cx),cy:Math.round(value.cy)}
        }else{
          if(typeof input.sourceId!=='string'||!input.sourceId||input.sourceId.length>256||input.keepSrcRect!==undefined&&typeof input.keepSrcRect!=='boolean')throw new Error('INVALID_TARGET')
          const matches=slide.elements.filter(element=>matchesElementRef(element,input.sourceId))
          if(matches.length!==1||matches[0]!.type!=='picture'||!matches[0]!.transform?.offset)throw new Error('INVALID_TARGET')
          targetId=elementDurableId(matches[0]!) ?? undefined
          offset=matches[0]!.transform!.offset!
        }
        const before=snapshot(state),records:OpRecord[]=[]
        try{
          const primary=input.mode==='insert'
            ? {op:'addPicture',target:{slide:input.slide},offset,bytes:media.bytes,ext:media.ext}
            : {op:'replacePicture',target:{slide:input.slide,el:targetId!},bytes:media.bytes,ext:media.ext,keepSrcRect:input.keepSrcRect===true}
          const first=runTxn(state,{isolation:'atomic',ops:[primary as Op]})
          if(!first.applied||!first.records?.length)throw new Error('INVALID_MEDIA')
          records.push(...first.records)
          if(input.mode==='insert'){
            const id=first.records[0]?.created?.[0]
            if(!id)throw new Error('INVALID_MEDIA')
            const crop=coverCropFractions(media.size.w,media.size.h,offset!.cx,offset!.cy)
            if(crop){
              const second=runTxn(state,{isolation:'atomic',ops:[{op:'setPictureSrcRect',target:{slide:input.slide,el:id},srcRect:crop}]})
              if(!second.applied)throw new Error('INVALID_MEDIA')
              records.push(...(second.records??[]))
            }
          }else if(!input.keepSrcRect){
            const crop=coverCropFractions(media.size.w,media.size.h,offset!.cx,offset!.cy)
            const second=runTxn(state,{isolation:'atomic',ops:[{op:'setPictureSrcRect',target:{slide:input.slide,el:targetId!},srcRect:crop}]})
            if(!second.applied)throw new Error('INVALID_MEDIA')
            records.push(...(second.records??[]))
          }
          historyCost(state)
        }catch(error){restore(state,before);throw error}
        redoStack.length=0;redoBytes=0
        push(undoStack,before)
        generation++;stateGeneration=generation
        const safeRecords=records.map(record=>({op:{op:record.op.op},...(record.slideId?{slideId:record.slideId}:{}),...(record.created?{created:record.created}:{}),...(record.after?{after:record.after}:{})}))
        return {generation,stateGeneration,...history(),records:safeRecords,...outlineOf(state),created:createdOf(state,records),transaction:{applied:true,records:safeRecords}}
      })
    },
    beginHistoryBatch(expected,signal){
      return enqueue(expected,signal,state=>{
        if(batchDepth===0)batchBefore=snapshot(state)
        batchDepth++
        return true
      })
    },
    endHistoryBatch(expected,signal){
      return enqueue(expected,signal,()=>{
        if(batchDepth===0)return {snapshotId:null,...history()}
        if(--batchDepth>0)return {snapshotId:null,...history()}
        const before=batchBefore;batchBefore=undefined
        if(!before||before.atGeneration===stateGeneration)return {snapshotId:null,...history()}
        push(undoStack,before)
        const id=++nextSnapshotId
        aiSnapshots.set(id,before);aiSnapshotBytes+=before.bytes
        while(aiSnapshots.size>MAX_HISTORY||aiSnapshotBytes>MAX_HISTORY_BYTES){
          const oldest=aiSnapshots.keys().next().value!
          aiSnapshotBytes-=aiSnapshots.get(oldest)!.bytes;aiSnapshots.delete(oldest)
        }
        return {snapshotId:aiSnapshots.has(id)?id:null,...history()}
      })
    },
    restoreSnapshot(expected,snapshotId,signal){
      return enqueue(expected,signal,state=>{
        if(batchDepth>0)throw new Error('HISTORY_BATCH_ACTIVE')
        if(!Number.isSafeInteger(snapshotId)||snapshotId<1)throw new Error('INVALID_SNAPSHOT')
        const target=aiSnapshots.get(snapshotId)
        if(!target)return null
        const current=snapshot(state)
        let slides:RenderSlide[]
        try{restore(state,target);slides=renderSlides(state,DEFAULT_FIT_WIDTH_PX)}
        catch(error){restore(state,current);throw error}
        redoStack.length=0;redoBytes=0;push(undoStack,current)
        for(const [id,snapshot]of aiSnapshots)if(id>=snapshotId){aiSnapshotBytes-=snapshot.bytes;aiSnapshots.delete(id)}
        generation++
        return {generation,stateGeneration,...history(),size:{...state.deck.size},slides}
      })
    },
    undo(expected,signal) {
      return enqueue(expected,signal,state=>{
        if(batchDepth>0)throw new Error('HISTORY_BATCH_ACTIVE')
        if (undoStack.length===0) throw new Error('NOTHING_TO_UNDO')
        const current=snapshot(state)
        const snap=undoStack[undoStack.length-1]!
        let slides: RenderSlide[]
        try { restore(state,snap); slides=renderSlides(state,DEFAULT_FIT_WIDTH_PX) }
        catch (error) { restore(state,current); throw error }
        undoStack.pop(); undoBytes-=snap.bytes
        push(redoStack,current)
        generation++
        return {generation,stateGeneration,...history(),size:{...state.deck.size},slides}
      })
    },
    redo(expected,signal) {
      return enqueue(expected,signal,state=>{
        if(batchDepth>0)throw new Error('HISTORY_BATCH_ACTIVE')
        if (redoStack.length===0) throw new Error('NOTHING_TO_REDO')
        const current=snapshot(state)
        const snap=redoStack[redoStack.length-1]!
        let slides: RenderSlide[]
        try { restore(state,snap); slides=renderSlides(state,DEFAULT_FIT_WIDTH_PX) }
        catch (error) { restore(state,current); throw error }
        redoStack.pop(); redoBytes-=snap.bytes
        push(undoStack,current)
        generation++
        return {generation,stateGeneration,...history(),size:{...state.deck.size},slides}
      })
    },
    render(expected,slide,width,signal) {
      return enqueue(expected,signal,state=>{
        if (!Number.isSafeInteger(slide) || slide<0 || slide>=state.deck.slides.length) throw new Error('INVALID_SLIDE')
        return structuredClone(buildRenderSlide(state.deck.slides[slide]!,state.deck.size,{fitWidthPx:fitWidth(width),slideNo:slide+1,media:mediaResolver(state)}))
      })
    },
    chartData(expected,slide,sourceId,signal) {
      return enqueue(expected,signal,state=>{
        if(!Number.isSafeInteger(slide)||slide<0||slide>=state.deck.slides.length)throw new Error('INVALID_SLIDE')
        if(typeof sourceId!=='string'||!sourceId||sourceId.length>256)throw new Error('INVALID_ELEMENT')
        const page=state.deck.slides[slide]!,element=page.elements.find(element=>matchesElementRef(element,sourceId))
        return element?structuredClone(getChartElementData(page,element.id)):null
      })
    },
    chartColorSchemes(expected,signal) {
      return enqueue(expected,signal,state=>['default','colorful','colorful2',...chartColors(state,'colorful')!.map((_,i)=>`mono-accent${i+1}`)].map(key=>({key,colors:chartColors(state,key)!})))
    },
    animations(expected,slide,signal) {
      return enqueue(expected,signal,state=>{
        if(!Number.isSafeInteger(slide)||slide<0||slide>=state.deck.slides.length)throw new Error('INVALID_SLIDE')
        const page=state.deck.slides[slide]!,elements=new Map(page.elements.map(element=>[elementSpid(element),element]))
        return getSlideAnimations(page).flatMap(item=>{const element=elements.get(item.spid);return element?[{sourceId:elementDurableId(element)??element.id,targetName:element.name||element.type,effect:item.effect,trigger:item.trigger,durationMs:item.durationMs,delayMs:item.delayMs,...(item.direction!==undefined?{direction:item.direction}:{}),...(item.motionPath!==undefined?{motionPath:item.motionPath}:{}),...(item.paragraph!==undefined?{paragraph:item.paragraph}:{})}]:[]}) as AnimationItem[]
      })
    },
    links(expected,slide,signal) {
      return enqueue(expected,signal,state=>{
        if(!Number.isSafeInteger(slide)||slide<0||slide>=state.deck.slides.length)throw new Error('INVALID_SLIDE')
        return getSlideLinks(state,slide).map(({elementId,target})=>{const element=state.deck.slides[slide]!.elements.find(element=>element.id===elementId);return {sourceId:element?elementDurableId(element)??element.id:elementId,target}})
      })
    },
    runLinks(expected,slide,signal) {
      return enqueue(expected,signal,state=>{
        if(!Number.isSafeInteger(slide)||slide<0||slide>=state.deck.slides.length)throw new Error('INVALID_SLIDE')
        return getRunLinks(state,slide).map(({elementId,...link})=>({sourceId:elementId,...link}))
      })
    },
    notes(expected,slide,signal) {
      return enqueue(expected,signal,state=>{
        if (!Number.isSafeInteger(slide) || slide<0 || slide>=state.deck.slides.length) throw new Error('INVALID_SLIDE')
        return getSlideNotes(state.archive,state.deck.slides[slide]!.path)
      })
    },
    comments(expected,slide,signal) {
      return enqueue(expected,signal,state=>{
        if (!Number.isSafeInteger(slide) || slide<0 || slide>=state.deck.slides.length) throw new Error('INVALID_SLIDE')
        return getSlideComments(state.archive,state.deck.slides[slide]!.path)
      })
    },
    layouts(expected,signal) {
      return enqueue(expected,signal,state=>{
        const layouts=listSlideLayouts(state.archive)
        if(shouldOfferBuiltinLayouts(layouts))layouts.push(...builtinLayoutInfos(state.deck.size,new Set(layouts.map(layout=>layout.name))))
        return {layouts,size:{...state.deck.size}}
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
      if (opened) { opened=undefined; undoStack.length=0; undoBytes=0; redoStack.length=0; redoBytes=0;batchBefore=undefined;batchDepth=0;aiSnapshots.clear();aiSnapshotBytes=0 }
    },
  }
}

// ── child-process IPC loop: one untrusted deck per isolated Node child ──

export interface PptxChildBinding { fileId: string; revision: string }
interface ChildMessage { snapshotId?:number; id: number; m: string; expected?: number; ops?: unknown; isolation?: 'atomic' | 'per_op'; dryRun?: boolean; slide?: number; width?: number; sourceId?:string;patch?:Record<string,unknown>;specJson?:string;images?:Array<{url:string;bytes:Uint8Array;ext:string}>;image?:SlidesImageCommand;markers?:string[];mode?:'replace'|'append'|'replace_at'|'insert_at';atIndex?:number; bytes?: Uint8Array; binding?: PptxChildBinding }
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
          case 'apply': reply(id,{id,ok:true,result:await session.apply(raw.expected!,raw.ops,undefined,{isolation:raw.isolation,dryRun:raw.dryRun})}); return
          case 'editChart': reply(id,{id,ok:true,result:await session.editChart(raw.expected!,raw.slide!,raw.sourceId!,raw.patch!)}); return
          case 'generatePage': reply(id,{id,ok:true,result:await session.generatePage(raw.expected!,raw.specJson!,raw.images!)}); return
          case 'landGeneratedPages': reply(id,{id,ok:true,result:await session.landGeneratedPages(raw.expected!,raw.markers!,raw.mode!,raw.atIndex)}); return
          case 'applyImage': if(!raw.image)throw new Error('INVALID_MEDIA');reply(id,{id,ok:true,result:await session.applyImage(raw.expected!,raw.image)}); return
          case 'historyBatchBegin': reply(id,{id,ok:true,result:await session.beginHistoryBatch(raw.expected!)}); return
          case 'historyBatchEnd': reply(id,{id,ok:true,result:await session.endHistoryBatch(raw.expected!)}); return
          case 'snapshotRestore': reply(id,{id,ok:true,result:await session.restoreSnapshot(raw.expected!,raw.snapshotId!)}); return
          case 'undo': reply(id,{id,ok:true,result:await session.undo(raw.expected!)}); return
          case 'redo': reply(id,{id,ok:true,result:await session.redo(raw.expected!)}); return
          case 'render': reply(id,{id,ok:true,result:await session.render(raw.expected!,raw.slide!,raw.width)}); return
          case 'chartData': reply(id,{id,ok:true,result:await session.chartData(raw.expected!,raw.slide!,raw.sourceId!)}); return
          case 'chartColorSchemes': reply(id,{id,ok:true,result:await session.chartColorSchemes(raw.expected!)}); return
          case 'animations': reply(id,{id,ok:true,result:await session.animations(raw.expected!,raw.slide!)}); return
          case 'links': reply(id,{id,ok:true,result:await session.links(raw.expected!,raw.slide!)}); return
          case 'runLinks': reply(id,{id,ok:true,result:await session.runLinks(raw.expected!,raw.slide!)}); return
          case 'notes': reply(id,{id,ok:true,result:await session.notes(raw.expected!,raw.slide!)}); return
          case 'comments': reply(id,{id,ok:true,result:await session.comments(raw.expected!,raw.slide!)}); return
          case 'layouts': reply(id,{id,ok:true,result:await session.layouts(raw.expected!)}); return
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

