export type AssistantSourceMode = 'off' | 'metadata-only' | 'read-only-analysis'
export const ASSISTANT_ANALYSIS_OPERATIONS = ['sources.list','sources.describe','sources.query','sources.read_result'] as const

export function assistantSourceTools(mode: AssistantSourceMode): string[] {
  if (mode === 'read-only-analysis') return ASSISTANT_ANALYSIS_OPERATIONS.map(name => name.replaceAll('.', '_'))
  return mode === 'metadata-only' ? ['sources_list'] : []
}

/** Read tools available to every assistant host. */
export const ASSISTANT_READ_TOOLS = new Set([
  'get_document_context','read_blocks','read_revisions','read_comments','read_notes',
  'get_workbook_context','read_range','aggregate_range','load_guide','read_formats',
  'read_sheet_features','read_cells','find_cells','trace_precedents','trace_dependents',
])
export function assistantReadTools(sourceCatalog: boolean | AssistantSourceMode = false): ReadonlySet<string> {
  return new Set([...ASSISTANT_READ_TOOLS, ...assistantSourceTools(sourceCatalog === true ? 'metadata-only' : sourceCatalog || 'off')])
}
/** Existing native DOCX operations, executed by the mounted editor, never by a harness. */
export const ASSISTANT_DOCUMENT_TOOLS = new Set([
  'write_document','insert_content','replace_blocks','replace_selection','apply_ops',
])
export type AssistantDocumentFormat = 'docx' | 'xlsx' | 'pptx' | 'pdf'
export const ASSISTANT_MAX_REQUEST_BYTES=10*1024*1024
export const AI_TURN_TIMED_OUT='AI_TURN_TIMED_OUT'
// Separate the bounded Web turn lifetime from the editor's silence watchdog.
export const PPTX_GENERATION_DEADLINE_MS=240_000
export const ASSISTANT_FORMAT_TOOLS: Readonly<Record<AssistantDocumentFormat, ReadonlySet<string>>> = {
  docx: new Set([
    'get_document_context','read_blocks','read_attachment','read_knowledge_file','search_knowledge_base','insert_content','write_document','replace_blocks','replace_selection','apply_ops',
    'read_revisions','accept_changes','reject_changes','read_comments','reply_comment','resolve_comment',
    'insert_footnote','insert_endnote','delete_note','edit_note','read_notes','add_comment','delete_comment',
    'web_search','image_search','analyze_media','generate_image','insert_image','insert_chart','edit_chart','set_header_footer',
    'set_page_setup','insert_section_break','define_style','list_styles','set_watermark','insert_text_box','insert_picture','create_document','generate_mindmap',
    'insert_data_result','insert_analysis_image',
  ]),
  xlsx: new Set([
    'get_workbook_context','read_attachment','read_range','aggregate_range','load_guide','read_formats','read_sheet_features',
    'read_cells','find_cells','select_range','trace_precedents','trace_dependents','propose_operations','create_document','merge_attached_workbooks','web_search','image_search','generate_image',
    'insert_data_result',
  ]),
  pptx: new Set([
    'read_slide','execute_slide_script','read_attachment','web_search','image_search','generate_image','analyze_media','insert_web_image','replace_image','ask_clarification','plan_deck','regenerate_slide','generate_deck','save_style_template','list_style_templates','edit_chart','apply_ops','load_guide',
    'insert_data_result','insert_analysis_image',
  ]),
  pdf: new Set([
    'read_pages','read_attachment','search_text','find_sensitive_info','goto_page','markup_text','read_annotations','add_note','reply_note',
    'edit_note','delete_markup','delete_note','edit_text','edit_block','move_text_block','insert_text','add_form_mark',
    'list_inserted_text','edit_inserted_text','move_inserted_text','delete_inserted_text','image_search','generate_image',
    'list_page_images','insert_image','transform_image','rotate_image','replace_image','flip_image','set_image_opacity',
    'crop_image','remove_image_background','delete_image','list_form_fields','apply_ops','insert_blank_page','set_page_size',
    'crop_pages','extract_pages','split_pdf','split_pages','merge_pages','confirm_pdf_copies','replace_pages','get_outline','set_watermark',
    'set_header_footer','create_document',
  ]),
}
export function assistantToolsForFormat(format: AssistantDocumentFormat, options: {sourceCatalog?: boolean; delegation?: boolean} = {}): ReadonlySet<string> {
  return new Set([
    ...ASSISTANT_FORMAT_TOOLS[format],
    ...(options.sourceCatalog ? ['sources_list'] : []),
    ...(options.delegation ? ASSISTANT_DELEGATION_TOOLS : []),
  ])
}
export function scopeAssistantRequest(request: unknown, fallbackTools: ReadonlySet<string>): {request: unknown; tools: ReadonlySet<string>;historicalTools:ReadonlySet<string>} {
  const fallback={request,tools:fallbackTools,historicalTools:fallbackTools}
  if (!request || typeof request !== 'object' || Array.isArray(request)) return fallback
  const value = request as Record<string, unknown>
  const format = value.format
  if (format !== undefined && format !== 'docx' && format !== 'xlsx' && format !== 'pptx' && format !== 'pdf') throw new Error('Unsupported assistant format')
  const permitted = format === undefined ? fallbackTools : new Set([
    ...assistantToolsForFormat(format, {delegation: [...ASSISTANT_DELEGATION_TOOLS].some(name => fallbackTools.has(name))}),
    ...assistantSourceTools('read-only-analysis').filter(name => fallbackTools.has(name)),
  ])
  const wire = {...value}
  delete wire.format
  const offeredTools = new Set<string>()
  if (Array.isArray(value.tools)) {
    wire.tools = value.tools.filter(tool => {
      if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return true
      const name = (tool as {name?: unknown}).name
      if (typeof name !== 'string') return true
      if (!permitted.has(name)) return false
      offeredTools.add(name)
      return true
    })
  }
  if(format===undefined)return {request:wire,tools:offeredTools,historicalTools:fallbackTools}
  // A resumed run has a paired Harness result but must not offer it again.
  const historicalTools=new Set(offeredTools)
  if(fallbackTools.has('delegate_agent_task'))historicalTools.add('delegate_agent_task')
  // Prior PDF turns may have read an attachment that is no longer offered.
  if(format==='pdf')historicalTools.add('read_attachment')
  return {request: wire, tools: offeredTools,historicalTools}
}
export interface AssistantModel {id: string; label: string; model: string; providerId?: string}
export const ASSISTANT_DELEGATION_TOOLS = new Set(['list_agents', 'list_agent_data', 'delegate_agent_task','list_channel_agents','delegate_channel_task'])
export interface AssistantCatalog {
  entries: AssistantModel[]; defaultId: string | null
  agents?: {id: string; name: string; origin: 'builtin' | 'external'; capabilities: readonly string[]}[]
  defaultAgentId?: string
  sourceCatalog?:boolean
  sourceMode?:AssistantSourceMode
  assistantChannels?:boolean
}
