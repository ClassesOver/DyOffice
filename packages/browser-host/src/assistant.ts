import {sourceResultBase} from '../../web-contracts/src/source-results.ts'
import type {AgentTransport,AgentStreamRequest,AgentToolDef} from '@genoffice/agent-core'
import {createSseAgentTransport,serializeTurnRequest} from './ai-transport.ts'
import type {SettingsRequest} from './preferences.ts'
import {createWorkspaceSourceSkill} from './source-skill.ts'
import {createSourceCatalogSkill} from './source-catalog-skill.ts'
import {createCodingClient} from './coding.ts'
import type {TaskIdStorage} from './coding-recovery.ts'
import {assistantReadTools, assistantSourceTools, assistantToolsForFormat, ASSISTANT_DOCUMENT_TOOLS, ASSISTANT_DELEGATION_TOOLS, ASSISTANT_MAX_REQUEST_BYTES, PPTX_GENERATION_DEADLINE_MS, type AssistantCatalog} from '../../web-contracts/src/assistant.ts'

type MediaAnalysis={image:boolean;video:boolean}
function scopeMediaAnalysis(tool:AgentToolDef,capabilities:MediaAnalysis):AgentToolDef{
  const {image,video}=capabilities
  const properties={...tool.inputSchema.properties as Record<string,unknown>}
  if(!image){delete properties.blockIndex;delete properties.attachmentIndex}
  const localImageFields=['blockIndex','attachmentIndex'].filter(name=>Object.hasOwn(properties,name))
  const kinds=image?(video?'images, video or audio':'images'):'video or audio'
  properties.mediaUrls={type:'array',items:{type:'string'},minItems:1,description:`HTTP(S) URLs for ${kinds}.`+(image&&video?' Put images and video/audio in separate calls.':'')}
  const scoped={...tool}
  scoped.description=`Analyze ${kinds} and return text.`+(localImageFields.length?` For a document or message image use ${localImageFields.join(' or ')} when applicable, or pass URLs.`:' Pass URLs.')
  scoped.inputSchema={...tool.inputSchema,properties,required:localImageFields.length?['requirements']:['mediaUrls','requirements'],additionalProperties:false}
  return scoped
}

export async function createAssistantClient({request, fetchImpl, csrfToken, onDelivery,nativeDocumentEditing=false,format,nativeToolNames,mediaAnalysis,documentId,taskStorage,continuationRevision}: {request: SettingsRequest; fetchImpl?: typeof fetch; csrfToken?: string;nativeDocumentEditing?:boolean;format?:'docx'|'xlsx'|'pptx'|'pdf';nativeToolNames?:ReadonlySet<string>;mediaAnalysis?:MediaAnalysis;documentId?:string;taskStorage?:TaskIdStorage;continuationRevision?:()=>string|undefined;onDelivery?:(hint:unknown,agent:{id:string;name:string;origin:'builtin'|'external'})=>void|Promise<void>}) {
  const catalog = await request<AssistantCatalog>('/api/v1/ai/catalog')
  let selected = catalog.defaultId, runModel = selected, disposed = false
  // Keep the original session proof. A replacement login in another tab cannot
  // dispatch this document/chat using the new account's cookie.
  const csrf = csrfToken ?? (catalog.entries.length ? (await request<{csrfToken: string}>('/api/v1/auth/csrf')).csrfToken : '')
  const sourceMode = catalog.sourceMode ?? (catalog.sourceCatalog === true ? 'metadata-only' : 'off')
  const sourceTools = assistantSourceTools(sourceMode)
  const sourceSkill = sourceMode === 'read-only-analysis'
    ? createWorkspaceSourceSkill(request, {tools:sourceTools, ...(documentId === undefined ? {} : {documentId}), disposed:() => disposed})
    : sourceMode === 'metadata-only' ? createSourceCatalogSkill(request, () => disposed) : undefined
  const formatTools=format?assistantToolsForFormat(format):undefined
  const allowedTools = new Set(format
    ? [...[...(nativeToolNames ?? [])].filter(name => formatTools?.has(name)), ...sourceTools]
    : [...assistantReadTools(sourceMode),...(nativeDocumentEditing?ASSISTANT_DOCUMENT_TOOLS:[])])
  const editingEnabled = nativeDocumentEditing || (format !== 'pdf' && !!format && !!nativeToolNames?.size)
  const coding = catalog.agents?.length && catalog.defaultAgentId
    ? createCodingClient({agents: catalog.agents, defaultId: catalog.defaultAgentId, csrfToken: csrf, getModelId: () => runModel,
      ...(documentId!==undefined?{documentId}:{}),...(taskStorage?{storage:taskStorage}:{}),...(continuationRevision?{continuationRevision}:{}), ...(onDelivery ? {onDelivery} : {}), dataCatalog:async input=>{
      const [sources,results]=await Promise.all([
        request(sourceResultBase(documentId)+'/source-tools/execute','POST',{name:'sources.list',arguments:input.sourcesAfter?{after:input.sourcesAfter}:{}}),
        request(sourceResultBase(documentId)+'/data-results'+(input.resultsAfter?'?after='+encodeURIComponent(input.resultsAfter):'')),
      ])
      return {sources,results}
    }, ...(fetchImpl ? {fetchImpl} : {})}) : undefined
  const encoder = new TextEncoder()
  const prepare=(input:AgentStreamRequest):AgentStreamRequest=>{
      const tools = input.tools.filter(t => (allowedTools.has(t.name) || ((coding||input.tools.some(tool=>tool.name==='list_channel_agents')) && ASSISTANT_DELEGATION_TOOLS.has(t.name))))
        .filter(t=>t.name!=='analyze_media'||!mediaAnalysis||mediaAnalysis.image||mediaAnalysis.video)
        .map(t=>t.name==='analyze_media'&&mediaAnalysis?scopeMediaAnalysis(t,mediaAnalysis):t)
      const messages = input.messages.map(message => message.role === 'assistant'
        ? {role: message.role, text: message.text, toolCalls: message.toolCalls}
        : message)
    const formatLabel = format === 'xlsx' ? 'workbook' : format === 'pptx' ? 'presentation' : format === 'pdf' ? 'PDF' : 'document'
    const pdfPageEditingOffered=format==='pdf'&&tools.some(tool=>['apply_ops','insert_blank_page','set_page_size','crop_pages'].includes(tool.name))
    const pdfExtractionOffered=format==='pdf'&&tools.some(tool=>['extract_pages','split_pdf','split_pages','merge_pages'].includes(tool.name))
    const pdfTextEditingOffered=format==='pdf'&&tools.some(tool=>tool.name==='edit_text')
    const pdfAnnotationEditingOffered=format==='pdf'&&tools.some(tool=>['markup_text','add_note','delete_markup','delete_note','reply_note','edit_note'].includes(tool.name))
    const offered=(names:string[])=>names.filter(name=>tools.some(tool=>tool.name===name)).join(', ')
    const confirmedPageSaves=offered(['crop_pages','set_page_size','replace_pages'])
    const pdfCopies=offered(['extract_pages','split_pdf','split_pages','merge_pages'])
    const instruction = format === 'pdf'
      ? nativeDocumentEditing
        ? '\nUse only the offered PDF tools. Ordinary edits create unsaved drafts in the open editor; tell the user to save to create a new revision. Never claim a draft has been saved.'
          +(confirmedPageSaves?` ${confirmedPageSaves} require a clean editor and user confirmation. A successful result confirms a new revision of the current file; re-read the pages afterward.`:'')
          +(pdfCopies?` ${pdfCopies} create separate saved PDF files and leave the source unchanged. A partial result does not mean the batch succeeded.`:'')
          +(offered(['create_document'])?' create_document saves a separate file only when its result confirms a saved revision.':'')
        : pdfPageEditingOffered
        ? '\nUse the offered PDF tools to read and edit pages. Page operations save a new revision immediately. Use original page numbers within one batch, then re-read pages and annotations after saving because page numbers and annotation IDs may change. Cropping changes only the CropBox; it does not redact or delete hidden content. dry_run validates only operation layout, not protection or writability. Only confirm changes after a successful tool result.'
        : pdfExtractionOffered
        ? '\nUse the offered PDF tools to read and extract or split pages into new saved PDFs. The source keeps its pages. Partial or canceled batches are not full success; confirm their existing save results instead of regenerating files. Only confirm creation after a successful tool result; do not claim unoffered file modifications.'
        : pdfTextEditingOffered
        ? '\nUse the offered PDF tools to read and edit original text. Successful edits save a new revision immediately. Read before editing and only confirm changes after the tool reports a saved revision. Delegate programming and computation to the offered harness tools.'
        : pdfAnnotationEditingOffered
        ? '\nUse the offered PDF annotation tools. Read annotations before editing, replying or deleting; preserve note authors and threads when editing, and only remove what the user explicitly requested. Successful changes save a new revision immediately; only confirm changes after a successful tool result. Use only the tools offered in this turn.'
        : '\nThis PDF session is read-only. Use only the offered reading and navigation tools; do not claim to edit or save the PDF.'
      : editingEnabled
        ? `\nUse the offered native ${formatLabel} tools for the open file. Delegate programming and computation to harnesses, then apply requested file changes using native tools. Direct CLI execution is unavailable.`
        : coding?'\nThis assistant can read and explain. Document mutation and direct CLI execution are unavailable. You may delegate coding using the offered agent tools.':'\nThis assistant can read and explain. Document mutation and CLI execution are unavailable.'
    const videoOnly=mediaAnalysis?.video&&!mediaAnalysis.image&&tools.some(tool=>tool.name==='analyze_media')
    return {...input,messages,tools,system:input.system+instruction+(videoOnly?'\nThe analyze_media tool supports video and audio URLs only. Do not use it for document or attachment images.':'')}
  }
  const active = new Set<{cancel(): void}>()
  const transport: AgentTransport = {
    beginRun(resumeModelId) {
      if(!resumeModelId)coding?.resetContinuation()
      const next=resumeModelId??selected
      const changed = runModel !== next
      runModel = next
      return changed
    },
    stream(input, callbacks) {
      if (disposed || !catalog.entries.some(e => e.id === runModel)) {
        callbacks.onError('助手当前不可用。'); callbacks.onDone(); return {cancel() {}}
      }
      const prepared=prepare(input), {tools,messages}=prepared
      const harnessResume=coding?.continuationFor(messages)
      if (encoder.encode(serializeTurnRequest('00000000-0000-0000-0000-000000000000',runModel??undefined,prepared,format,undefined,undefined,harnessResume)).length>ASSISTANT_MAX_REQUEST_BYTES) {
        callbacks.onError('附件和对话超过 10 MiB，请减少图片数量或附件内容后重试。')
        callbacks.onDone()
        return {cancel() {}}
      }
      if (messages.some(message => message.role === 'user' && encoder.encode(message.text).length > 256 * 1024)) {
        callbacks.onError('消息、文档上下文和附加 Skills 超出模型请求上限。请缩短消息或减少附加 Skills。')
        callbacks.onDone()
        return {cancel() {}}
      }
      let handle: {cancel(): void}
      handle = createSseAgentTransport({modelId: runModel!, ...(format ? {format} : {}), ...(format==='pptx'&&!tools.length ? {timeoutMs:PPTX_GENERATION_DEADLINE_MS} : {}), ...(harnessResume ? {harnessResume} : {}), getCsrfToken: async () => csrf, ...(fetchImpl ? {fetchImpl} : {})}).stream(prepared, {...callbacks, onToolCall(call) {
        if (!tools.some(t => t.name === call.name)) throw new Error('助手返回了未授权的工具。')
        callbacks.onToolCall(call)
      }, onDone(disposition) {active.delete(handle); callbacks.onDone(disposition)}})
      active.add(handle)
      return handle
    },
  }
  return {
    // Default transport turn IDs are UUIDs (36 ASCII bytes). All other bytes
    // use the identical normalized request and serializer as dispatch.
    requestBytes(input:AgentStreamRequest){return encoder.encode(serializeTurnRequest('00000000-0000-0000-0000-000000000000',selected??undefined,prepare(input),format)).length},
    catalog, transport, coding, extraSkills: [...(coding ? [coding.skill] : []), ...(sourceSkill ? [sourceSkill] : [])],
    selected: () => selected,
    currentRunModel: () => runModel,
    select(id: string) {if (disposed || !catalog.entries.some(e => e.id === id)) throw new Error('模型不可用。'); selected = id},
    available: catalog.entries.length > 0,
    dispose() {coding?.dispose(); disposed = true; for (const handle of active) handle.cancel(); active.clear()},
  }
}
