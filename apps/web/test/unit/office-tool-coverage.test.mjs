import assert from 'node:assert/strict'
import test from 'node:test'
import {ASSISTANT_FORMAT_TOOLS, ASSISTANT_DELEGATION_TOOLS, assistantSourceTools} from '../../../../packages/web-contracts/src/assistant.ts'
import {summarizeOfficeToolCoverage} from '../helpers/office-tool-coverage.mjs'

const pdfEffects = [
  'apply_ops.rotatePages', 'apply_ops.setFormValue', 'apply_ops.setMetadata',
  'edit_block', 'move_text_block', 'edit_text', 'insert_text', 'edit_inserted_text',
  'move_inserted_text', 'delete_inserted_text', 'edit_note', 'reply_note', 'delete_note',
  'markup_text', 'delete_markup', 'insert_blank_page', 'set_watermark', 'set_header_footer',
]
const artifacts = [
  ...['docx','xlsx','pptx'].map(format => ({format,verifiedEffect:'insert_data_result'})),
  ...pdfEffects.map(verifiedEffect => ({format:'pdf',verifiedEffect})),
]

function trace(omit = () => false, omitArtifact = undefined) {
  const events = Object.entries(ASSISTANT_FORMAT_TOOLS).map(([format, tools]) => {
    const names = [...tools]
    return {format, offered:names.filter(name => !omit(format, name, 'offer')),
      results:names.map(name => ({name,error:omit(format, name, 'result')}))}
  })
  const shared = [...ASSISTANT_DELEGATION_TOOLS, ...assistantSourceTools('read-only-analysis')]
  events.push({format:'workspace',offered:shared,results:shared.map(name => ({name,error:false}))})
  events.push(...artifacts.filter(event => event.format !== omitArtifact))
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
  assert.deepEqual(missing.effects, {verified:3,required:21})
  const verified = summarizeOfficeToolCoverage(trace())
  assert.deepEqual(verified.gaps, [])
  assert.deepEqual(verified.effects, {verified:21,required:21})
  assert.throws(
    () => summarizeOfficeToolCoverage(JSON.stringify({format:'xlsx',verifiedEffect:'apply_ops.rotatePages'})),
    {message:'Invalid Office tool trace at line 1'},
  )
})

test('one format’s saved table does not prove its peers’ native results', () => {
  for (const format of ['docx','xlsx','pptx']) {
    const summary = summarizeOfficeToolCoverage(trace(undefined, format))
    assert.deepEqual(summary.gaps, [format+': missing saved-artifact verification for insert_data_result'])
  }
})

test('an empty or malformed trace fails', () => {
  assert.ok(summarizeOfficeToolCoverage('').gaps.length > 0)
  assert.throws(() => summarizeOfficeToolCoverage('{private input'), {message:'Invalid Office tool trace at line 1'})
})
