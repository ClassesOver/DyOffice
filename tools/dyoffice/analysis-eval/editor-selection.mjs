import { withEditorPage } from './editor-page.mjs'
import { fileURLToPath } from 'node:url'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

const scenarios = [
  { format: 'docx', tool: 'add_comment', prompt: '给当前段落添加批注，内容为“请核对预算”。' },
  { format: 'xlsx', tool: 'read_cells', prompt: '读取当前工作表 A1 和 C3 两个不连续单元格的值和公式。' },
  { format: 'pptx', tool: 'list_style_templates', prompt: '列出可用的演示文稿样式模板。' },
  { format: 'pdf', tool: 'search_text', prompt: '搜索整份 PDF 里的“报名截止”，列出匹配位置。' },
]

const { values } = parseArgs({ options: {
  model: { type: 'string' }, trials: { type: 'string', default: '3' },
  out: { type: 'string', default: 'test-results/editor-selection' },
  'check-catalog': { type: 'boolean' },
} })
const entry = fileURLToPath(new URL('./editor-catalog.ts', import.meta.url))
const catalogs = await withEditorPage(entry, page => page.evaluate(() => Object.fromEntries(Object.entries(officeCatalog))))
for (const { format, tool } of scenarios) {
  const defs = catalogs[format]
  if (!defs.some(def => def.name === tool) || defs.some(def => !def.inputSchema || !def.description)) throw Error('Invalid catalog for ' + format)
  console.log(format, defs.length, 'native tool definitions')
}
if (!values['check-catalog']) {
  const base = process.env.DYOFFICE_EVAL_BASE_URL
  const trials = Number(values.trials)
  if (!base || !values.model || !Number.isSafeInteger(trials) || trials < 1) throw Error('Set DYOFFICE_EVAL_BASE_URL, --model and a positive --trials')
  const headers = { 'content-type': 'application/json' }
  if (process.env.DYOFFICE_EVAL_API_KEY) headers.authorization = 'Bearer ' + process.env.DYOFFICE_EVAL_API_KEY
  async function sample(prompt, tools) {
    try {
      const response = await fetch(base.replace(/\/$/, '') + '/chat/completions', { method: 'POST', headers, redirect: 'error',
        signal: AbortSignal.timeout(120000), body: JSON.stringify({ model: values.model, messages: [{role:'user',content:prompt}], ...(tools && { tools }) }) })
      if (!response.ok) throw Error('Model endpoint returned HTTP ' + response.status)
      const data = await response.json()
      const message = data.choices?.[0]?.message
      const tokens = data.usage?.prompt_tokens
      if (!message || typeof message !== 'object' || Array.isArray(message)) return { error:'Missing model response' }
      if (!Number.isSafeInteger(tokens) || tokens < 0) return { error:'Missing input token count', message }
      return { tokens, message }
    } catch (error) { return { error:error.message } }
  }
  const report = { model: values.model, trials, results: [], byFormat: {} }
  await mkdir(values.out, { recursive: true })
  for (const { format, prompt, tool } of scenarios) {
    const tools = catalogs[format].map(def => ({ type:'function', function:{name:def.name,description:def.description,parameters:def.inputSchema} }))
    const baseline = await sample(prompt)
    for (let trial = 1; trial <= trials; trial++) {
      const sampleResult = await sample(prompt, tools)
      const calls = sampleResult.message?.tool_calls
      const row = { format, prompt, trial, expected:tool, baselineTokens:baseline.tokens ?? null, promptTokens:sampleResult.tokens ?? null }
      if (sampleResult.error || baseline.error) {
        row.errors = { baseline:baseline.error, withTools:sampleResult.error }
        process.exitCode = 1
      }
      if (sampleResult.message) {
        row.calls = Array.isArray(calls) ? calls.map(call => call?.function?.name ?? null) : []
        row.correct = row.calls.length === 1 && row.calls[0] === tool
      }
      if (row.correct !== true || sampleResult.error) row.response = sampleResult.message
      if (baseline.error) row.baselineResponse = baseline.message
      if (row.promptTokens !== null && row.baselineTokens !== null) row.toolTokens = row.promptTokens - row.baselineTokens
      report.results.push(row)
      const completed = report.results.filter(item => item.format === format && item.correct !== undefined)
      const measured = completed.filter(item => item.toolTokens !== undefined)
      report.byFormat[format] = {
        completed: completed.length, measured: measured.length,
        selectionRate: completed.length ? completed.filter(item => item.correct).length / completed.length : null,
        meanToolTokens: measured.length ? measured.reduce((sum,item) => sum + item.toolTokens, 0) / measured.length : null,
      }
      await writeFile(join(values.out,'report.json'),JSON.stringify(report,null,2)+'\n')
    }
  }
}
