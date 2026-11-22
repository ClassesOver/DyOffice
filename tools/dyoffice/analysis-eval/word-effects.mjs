import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { withEditorPage } from './editor-page.mjs'

const { values } = parseArgs({ options: {
  model: { type: 'string' }, fixture: { type: 'boolean' }, out: { type: 'string', default: 'test-results/word-effects' },
} })
if (Boolean(values.fixture) === Boolean(values.model)) throw Error('Choose --fixture or --model MODEL')
const base = process.env.DYOFFICE_EVAL_BASE_URL
if (values.model && !base) throw Error('Set DYOFFICE_EVAL_BASE_URL')
const report = { model: values.model ?? null, fixture: !!values.fixture, results: [] }
await mkdir(values.out, { recursive: true })
await withEditorPage(fileURLToPath(new URL('./word-effects.ts', import.meta.url)), async page => {
  const { cases, definitions } = await page.evaluate(() => ({ cases:officeCatalog.cases, definitions:officeCatalog.definitions }))
  const tools = definitions.map(def => ({ type:'function', function:{name:def.name, description:def.description, parameters:def.inputSchema} }))
  for (const { name, prompt, input } of cases) {
    const row = { prompt, expected:name, passed:false }
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
      Object.assign(row, await page.evaluate(call => officeCatalog.check(call), call))
    } catch (error) { row.error = error.message }
    report.results.push(row)
    await writeFile(join(values.out, 'report.json'), JSON.stringify(report, null, 2) + '\n')
    console.log(name, row.passed ? 'passed' : row.error ?? row.output)
  }
})
if (report.results.some(row => !row.passed)) process.exitCode = 1
