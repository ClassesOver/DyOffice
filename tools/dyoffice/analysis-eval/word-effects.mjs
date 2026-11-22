import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { withEditorPage, withNodeModule } from './editor-page.mjs'

// One module per format: the real tool definitions plus check(call, index),
// which runs the call through that editor's executor on an in-memory document.
const modules = { docx: 'word', xlsx: 'sheet', pptx: 'slide', pdf: 'pdf' }
// The PPTX engine needs Node built-ins; the other editors run in Chromium.
const inNode = new Set(['pptx'])
const { values } = parseArgs({ options: {
  model: { type: 'string' }, fixture: { type: 'boolean' }, format: { type: 'string', default: 'docx' }, out: { type: 'string' },
} })
if (Boolean(values.fixture) === Boolean(values.model)) throw Error('Choose --fixture or --model MODEL')
if (!Object.hasOwn(modules, values.format)) throw Error('--format must be one of ' + Object.keys(modules).join(', '))
values.out ??= 'test-results/' + modules[values.format] + '-effects'
const base = process.env.DYOFFICE_EVAL_BASE_URL
if (values.model && !base) throw Error('Set DYOFFICE_EVAL_BASE_URL')
const report = { format: values.format, model: values.model ?? null, fixture: !!values.fixture, results: [] }
await mkdir(values.out, { recursive: true })
await (inNode.has(values.format) ? withNodeModule : withEditorPage)(fileURLToPath(new URL('./' + modules[values.format] + '-effects.ts', import.meta.url)), async page => {
  const { cases, definitions } = await page.evaluate(() => ({ cases:officeCatalog.cases, definitions:officeCatalog.definitions }))
  const tools = definitions.map(def => ({ type:'function', function:{name:def.name, description:def.description, parameters:def.inputSchema} }))
  for (const [index, { name, prompt, input }] of cases.entries()) {
    const row = { case:index, prompt, expected:name, passed:false }
    try {
      let call = { id:'fixture', name, input }
      if (values.model) {
        const headers = { 'content-type':'application/json' }
        if (process.env.DYOFFICE_EVAL_API_KEY) headers.authorization = 'Bearer ' + process.env.DYOFFICE_EVAL_API_KEY
        const response = await fetch(base.replace(/\/$/, '') + '/chat/completions', { method:'POST', redirect:'error',
          signal:AbortSignal.timeout(120000), headers, body:JSON.stringify({model:values.model, tools, messages:[{role:'user',content:prompt}]}) })
        if (!response.ok) throw Error('Gateway HTTP ' + response.status)
        const message = (await response.json()).choices?.[0]?.message
        row.response = message
        if (message?.tool_calls?.length !== 1) throw Error('Expected one tool call')
        const selected = message.tool_calls[0]
        call = { id:selected.id, name:selected.function.name, input:JSON.parse(selected.function.arguments) }
      }
      row.call = call
      if (call.name !== name) throw Error('Unexpected tool ' + call.name)
      Object.assign(row, await page.evaluate(([call, index]) => officeCatalog.check(call, index), [call, index]))
    } catch (error) { row.error = error.message }
    report.results.push(row)
    await writeFile(join(values.out, 'report.json'), JSON.stringify(report, null, 2) + '\n')
    console.log(values.format, index, name, row.passed ? 'passed' : row.error ?? row.output)
  }
})
if (report.results.some(row => !row.passed)) process.exitCode = 1
