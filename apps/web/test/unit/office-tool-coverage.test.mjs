import assert from 'node:assert/strict'
import test from 'node:test'
import {ASSISTANT_FORMAT_TOOLS, ASSISTANT_DELEGATION_TOOLS, assistantSourceTools} from '../../../../packages/web-contracts/src/assistant.ts'
import {summarizeOfficeToolCoverage} from '../helpers/office-tool-coverage.mjs'

const pdfEffects = [
  'apply_ops.rotatePages', 'apply_ops.setFormValue', 'apply_ops.setMetadata',
  'edit_block', 'move_text_block', 'edit_text', 'insert_text', 'edit_inserted_text',
  'move_inserted_text', 'delete_inserted_text', 'edit_note', 'reply_note', 'delete_note',
  'markup_text', 'delete_markup', 'insert_blank_page', 'set_watermark', 'set_header_footer',
  'image_search', 'generate_image', 'insert_image', 'transform_image', 'replace_image',
  'delete_image', 'rotate_image', 'flip_image', 'crop_image', 'set_image_opacity',
  'remove_image_background', 'apply_ops.setPageOrder', 'add_form_mark',
  'extract_pages', 'confirm_pdf_copies', 'split_pages', 'merge_pages', 'crop_pages',
  'set_page_size', 'replace_pages', 'split_pdf', 'create_document', 'add_note',
]
const pdfResults = [
  'read_pages', 'read_attachment', 'search_text', 'find_sensitive_info', 'goto_page',
  'read_annotations', 'list_inserted_text', 'list_page_images', 'list_form_fields', 'get_outline',
]
const xlsxResults = [
  'find_cells', 'get_workbook_context', 'read_range', 'read_cells', 'aggregate_range',
  'read_formats', 'trace_precedents', 'trace_dependents', 'load_guide', 'select_range',
  'read_sheet_features', 'read_attachment', 'web_search',
]
const xlsxEffects = [
  'insert_data_result', 'create_document', 'generate_image', 'image_search',
  'merge_attached_workbooks', 'propose_operations',
]
const pptxEffects = [
  'apply_ops', 'edit_chart', 'execute_slide_script', 'generate_deck', 'insert_analysis_image',
  'insert_data_result', 'insert_web_image', 'regenerate_slide', 'replace_image',
]
const pptxResults = [
  'analyze_media', 'ask_clarification', 'generate_image', 'image_search', 'list_style_templates',
  'load_guide', 'plan_deck', 'read_attachment', 'read_slide', 'save_style_template', 'web_search',
]
const docxEffects = [
  'accept_changes', 'add_comment', 'apply_ops', 'create_document', 'define_style',
  'delete_comment', 'delete_note', 'edit_chart', 'edit_note', 'generate_image',
  'insert_analysis_image', 'insert_chart', 'insert_content', 'insert_data_result', 'insert_endnote',
  'insert_footnote', 'insert_image', 'insert_picture', 'insert_section_break', 'insert_text_box',
  'reject_changes', 'replace_blocks', 'replace_selection', 'reply_comment', 'resolve_comment',
  'set_header_footer', 'set_page_setup', 'set_watermark', 'write_document',
]
const docxResults = [
  'analyze_media', 'generate_mindmap', 'get_document_context', 'image_search', 'list_styles',
  'read_attachment', 'read_blocks', 'read_comments', 'read_knowledge_file', 'read_notes',
  'read_revisions', 'search_knowledge_base', 'web_search',
]
const sharedResults = [
  'list_agents', 'list_agent_data', 'delegate_agent_task', 'list_channel_agents',
  'delegate_channel_task', 'sources_list', 'sources_describe', 'sources_query', 'sources_read_result',
]
const artifacts = [
  ...docxEffects.map(verifiedEffect => ({format:'docx',verifiedEffect})),
  ...pptxEffects.map(verifiedEffect => ({format:'pptx',verifiedEffect})),
  ...xlsxEffects.map(verifiedEffect => ({format:'xlsx',verifiedEffect})),
  ...pdfEffects.map(verifiedEffect => ({format:'pdf',verifiedEffect})),
]

function trace(omit = () => false, omitArtifact = undefined, omitResult = undefined) {
  const events = Object.entries(ASSISTANT_FORMAT_TOOLS).map(([format, tools]) => {
    const names = [...tools]
    return {format, offered:names.filter(name => !omit(format, name, 'offer')),
      results:names.map(name => ({name,error:omit(format, name, 'result')}))}
  })
  const shared = [...ASSISTANT_DELEGATION_TOOLS, ...assistantSourceTools('read-only-analysis')]
  events.push({format:'workspace',offered:shared,results:shared.map(name => ({name,error:false}))})
  events.push(...artifacts.filter(event => event.format !== omitArtifact))
  for (const [format,names] of [['pdf',pdfResults],['xlsx',xlsxResults],['pptx',pptxResults],['docx',docxResults],['shared',sharedResults]]) {
    events.push(...names.filter(name => omitResult?.format !== format || name !== omitResult.name)
      .map(verifiedEffect => ({format,verifiedEffect})))
  }
  return events.map(event => JSON.stringify(event)).join('\n')
}

test('coverage checks every format and shared tool against the Web contract', () => {
  const summary = summarizeOfficeToolCoverage(trace())
  assert.deepEqual(summary.gaps, [])
  assert.equal(summary.formats.pdf.executed, ASSISTANT_FORMAT_TOOLS.pdf.size)
  assert.equal(summary.shared.executed, ASSISTANT_DELEGATION_TOOLS.size + assistantSourceTools('read-only-analysis').length)
})

test('coverage reports missing registrations and failed calls in the relevant format', () => {
  const summary = summarizeOfficeToolCoverage(trace((format,name,kind) =>
    (format === 'docx' && name === 'read_attachment' && kind === 'offer') ||
    (format === 'pptx' && name === 'read_slide' && kind === 'result')))
  assert.deepEqual(summary.gaps, [
    'docx: missing registration for read_attachment',
    'pptx: missing successful execution for read_slide',
  ])
})

test('each required PDF effect must verify its saved artifact', () => {
  const missing = summarizeOfficeToolCoverage(trace(undefined, 'pdf'))
  assert.deepEqual(missing.gaps, pdfEffects.map(name => 'pdf: missing saved-artifact verification for '+name))
  assert.deepEqual(missing.effects, {verified:44,required:85})
  const verified = summarizeOfficeToolCoverage(trace())
  assert.deepEqual(verified.gaps, [])
  assert.deepEqual(verified.effects, {verified:85,required:85})
  assert.throws(
    () => summarizeOfficeToolCoverage(JSON.stringify({format:'xlsx',verifiedEffect:'apply_ops.rotatePages'})),
    {message:'Invalid Office tool trace at line 1'},
  )
})

test('every PDF tool must have verified content, navigation or saved effects', () => {
  assert.deepEqual(new Set([...pdfEffects.map(effect => effect.split('.')[0]), ...pdfResults]), ASSISTANT_FORMAT_TOOLS.pdf)
  assert.deepEqual(summarizeOfficeToolCoverage(trace()).resultEffects, {verified:56,required:56})
  for (const name of pdfResults) {
    const summary = summarizeOfficeToolCoverage(trace(undefined, undefined, {format:'pdf',name}))
    assert.deepEqual(summary.gaps, ['pdf: missing result verification for '+name])
    assert.deepEqual(summary.resultEffects, {verified:55,required:56})
  }
})

test('every XLSX tool requires saved evidence or verified results', () => {
  assert.deepEqual(new Set([...xlsxEffects, ...xlsxResults]), ASSISTANT_FORMAT_TOOLS.xlsx)
  const missing = summarizeOfficeToolCoverage(trace(undefined, 'xlsx'))
  assert.deepEqual(missing.gaps, xlsxEffects.map(name => 'xlsx: missing saved-artifact verification for '+name))
  for (const name of xlsxResults) {
    const summary = summarizeOfficeToolCoverage(trace(undefined, undefined, {format:'xlsx',name}))
    assert.deepEqual(summary.gaps, ['xlsx: missing result verification for '+name])
    assert.deepEqual(summary.resultEffects, {verified:55,required:56})
  }
})

test('every PPTX tool requires saved evidence or verified results', () => {
  assert.deepEqual(new Set([...pptxEffects, ...pptxResults]), ASSISTANT_FORMAT_TOOLS.pptx)
  assert.deepEqual(summarizeOfficeToolCoverage(trace(undefined, 'pptx')).gaps,
    pptxEffects.map(name => 'pptx: missing saved-artifact verification for '+name))
  for (const name of pptxResults) {
    const summary = summarizeOfficeToolCoverage(trace(undefined, undefined, {format:'pptx',name}))
    assert.deepEqual(summary.gaps, ['pptx: missing result verification for '+name])
  }
})

test('every DOCX tool requires saved evidence or verified results', () => {
  assert.deepEqual(new Set([...docxEffects, ...docxResults]), ASSISTANT_FORMAT_TOOLS.docx)
  assert.deepEqual(summarizeOfficeToolCoverage(trace(undefined, 'docx')).gaps,
    docxEffects.map(name => 'docx: missing saved-artifact verification for '+name))
  for (const name of docxResults) {
    const summary = summarizeOfficeToolCoverage(trace(undefined, undefined, {format:'docx',name}))
    assert.deepEqual(summary.gaps, ['docx: missing result verification for '+name])
  }
})

test('every shared source and delegation tool requires verified results', () => {
  assert.deepEqual(new Set(sharedResults), new Set([...ASSISTANT_DELEGATION_TOOLS, ...assistantSourceTools('read-only-analysis')]))
  for (const name of sharedResults) {
    const summary = summarizeOfficeToolCoverage(trace(undefined, undefined, {format:'shared',name}))
    assert.deepEqual(summary.gaps, ['shared: missing result verification for '+name])
  }
})

test('an empty or malformed trace fails', () => {
  assert.ok(summarizeOfficeToolCoverage('').gaps.length > 0)
  assert.throws(() => summarizeOfficeToolCoverage('{private input'), {message:'Invalid Office tool trace at line 1'})
})
