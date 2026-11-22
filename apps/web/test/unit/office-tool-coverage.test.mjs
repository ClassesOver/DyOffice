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
const artifacts = [
  {format:'docx',verifiedEffect:'insert_data_result'},
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
  for (const [format,names] of [['pdf',pdfResults],['xlsx',xlsxResults],['pptx',pptxResults]]) {
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
  assert.deepEqual(missing.effects, {verified:16,required:57})
  const verified = summarizeOfficeToolCoverage(trace())
  assert.deepEqual(verified.gaps, [])
  assert.deepEqual(verified.effects, {verified:57,required:57})
  assert.throws(
    () => summarizeOfficeToolCoverage(JSON.stringify({format:'xlsx',verifiedEffect:'apply_ops.rotatePages'})),
    {message:'Invalid Office tool trace at line 1'},
  )
})

test('every PDF tool must have verified content, navigation or saved effects', () => {
  assert.deepEqual(new Set([...pdfEffects.map(effect => effect.split('.')[0]), ...pdfResults]), ASSISTANT_FORMAT_TOOLS.pdf)
  assert.deepEqual(summarizeOfficeToolCoverage(trace()).resultEffects, {verified:34,required:34})
  for (const name of pdfResults) {
    const summary = summarizeOfficeToolCoverage(trace(undefined, undefined, {format:'pdf',name}))
    assert.deepEqual(summary.gaps, ['pdf: missing result verification for '+name])
    assert.deepEqual(summary.resultEffects, {verified:33,required:34})
  }
})

test('every XLSX tool requires saved evidence or verified results', () => {
  assert.deepEqual(new Set([...xlsxEffects, ...xlsxResults]), ASSISTANT_FORMAT_TOOLS.xlsx)
  const missing = summarizeOfficeToolCoverage(trace(undefined, 'xlsx'))
  assert.deepEqual(missing.gaps, xlsxEffects.map(name => 'xlsx: missing saved-artifact verification for '+name))
  for (const name of xlsxResults) {
    const summary = summarizeOfficeToolCoverage(trace(undefined, undefined, {format:'xlsx',name}))
    assert.deepEqual(summary.gaps, ['xlsx: missing result verification for '+name])
    assert.deepEqual(summary.resultEffects, {verified:33,required:34})
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

test('one format’s saved table does not prove its peers’ native results', () => {
  const summary = summarizeOfficeToolCoverage(trace(undefined, 'docx'))
  assert.deepEqual(summary.gaps, ['docx: missing saved-artifact verification for insert_data_result'])
})

test('an empty or malformed trace fails', () => {
  assert.ok(summarizeOfficeToolCoverage('').gaps.length > 0)
  assert.throws(() => summarizeOfficeToolCoverage('{private input'), {message:'Invalid Office tool trace at line 1'})
})
