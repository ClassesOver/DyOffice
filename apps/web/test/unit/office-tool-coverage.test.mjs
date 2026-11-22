import assert from 'node:assert/strict'
import test from 'node:test'
import {ASSISTANT_FORMAT_TOOLS, ASSISTANT_DELEGATION_TOOLS, assistantSourceTools} from '../../../../packages/web-contracts/src/assistant.ts'
import {summarizeOfficeToolCoverage} from '../helpers/office-tool-coverage.mjs'

function trace(omit = () => false) {
  const events = Object.entries(ASSISTANT_FORMAT_TOOLS).map(([format, tools]) => {
    const names = [...tools].filter(name => !(format === 'pdf' && name === 'rotate_pages'))
    return {format, offered:names.filter(name => !omit(format, name, 'offer')),
      results:names.map(name => ({name,error:omit(format, name, 'result')}))}
  })
  const shared = [...ASSISTANT_DELEGATION_TOOLS, ...assistantSourceTools('read-only-analysis')]
  events.push({format:'workspace',offered:shared,results:shared.map(name => ({name,error:false}))})
  return events.map(event => JSON.stringify(event)).join('\n')
}

test('coverage checks every format and shared tool against the Web contract', () => {
  const summary = summarizeOfficeToolCoverage(trace())
  assert.deepEqual(summary.gaps, [])
  assert.equal(summary.formats.pdf.compatibilityTools, 1)
  assert.equal(summary.formats.pdf.executed, ASSISTANT_FORMAT_TOOLS.pdf.size - 1)
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

test('a registered PDF rotation alias needs direct success and an empty or malformed trace fails', () => {
  const alias = JSON.stringify({format:'pdf',offered:['rotate_pages'],results:[]})
  assert.ok(summarizeOfficeToolCoverage(trace()+'\n'+alias).gaps.includes('pdf: missing successful execution for rotate_pages'))
  assert.ok(summarizeOfficeToolCoverage('').gaps.length > 0)
  assert.throws(() => summarizeOfficeToolCoverage('{private input'), {message:'Invalid Office tool trace at line 1'})
})
