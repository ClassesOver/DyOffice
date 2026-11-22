import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { fileURLToPath } from 'node:url'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { workspaceAliases } from '../../../apps/web/workspace-aliases.mjs'

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
const aliases = workspaceAliases()
const bundle = await build({
  entryPoints:[entry], write:false, bundle:true, platform:'browser', format:'iife', globalName:'officeCatalog', treeShaking:true,
  define:{'import.meta.env':JSON.stringify({BASE_URL:'/',DEV:false}),'process.env.NODE_ENV':'"production"'}, loader:{'.css':'empty','.svg':'text','.png':'empty','.ttf':'empty'},
  plugins:[{name:'editor-catalog-imports',setup(build){
    build.onResolve({filter:/\?raw$/},args=>({path:resolve(args.resolveDir,args.path.slice(0,-4)),namespace:'raw-text'}))
    build.onLoad({filter:/.*/,namespace:'raw-text'},async args=>({contents:await readFile(args.path,'utf8'),loader:'text'}))
    build.onResolve({filter:/^@genoffice\//},async args=>{
      const alias=aliases.find(item=>item.find.test(args.path))
      if(!alias)return
      return build.resolve(args.path.replace(alias.find,alias.replacement),{resolveDir:args.resolveDir,kind:args.kind})
    })
  }}],
})
const browser = await chromium.launch(process.env.DYOFFICE_TEST_CHROMIUM_PATH ? { executablePath:process.env.DYOFFICE_TEST_CHROMIUM_PATH } : {})
let catalogs
try {
  const page=await browser.newPage()
  await page.route('**/*',route=>route.abort())
  await page.setContent('<base href="https://eval.invalid/">')
  let scriptFailure
  page.on('pageerror',error=>{scriptFailure=error})
  await page.addScriptTag({content:bundle.outputFiles[0].text})
  if(scriptFailure)throw scriptFailure
  catalogs=await page.evaluate(()=>Object.fromEntries(Object.entries(officeCatalog)))
} finally { await browser.close() }
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
    const response = await fetch(base.replace(/\/$/, '') + '/chat/completions', { method: 'POST', headers, redirect: 'error',
      signal: AbortSignal.timeout(120000), body: JSON.stringify({ model: values.model, messages: [{role:'user',content:prompt}], ...(tools && { tools }) }) })
    if (!response.ok) throw Error('Model endpoint returned HTTP ' + response.status)
    const data = await response.json()
    if (!Number.isSafeInteger(data.usage?.prompt_tokens) || !data.choices?.[0]?.message) throw Error('Missing model response or input token count')
    return { tokens: data.usage.prompt_tokens, calls: (data.choices[0].message.tool_calls ?? []).map(call => call.function.name) }
  }
  const report = { model: values.model, trials, results: [], byFormat: {} }
  await mkdir(values.out, { recursive: true })
  for (const { format, prompt, tool } of scenarios) {
    const tools = catalogs[format].map(def => ({ type:'function', function:{name:def.name,description:def.description,parameters:def.inputSchema} }))
    const baseline = await sample(prompt)
    for (let trial = 1; trial <= trials; trial++) {
      const result = await sample(prompt, tools)
      report.results.push({ format, prompt, trial, expected:tool, calls:result.calls, correct:result.calls.length===1 && result.calls[0]===tool, promptTokens:result.tokens, baselineTokens:baseline.tokens, toolTokens:result.tokens-baseline.tokens })
      const completed = report.results.filter(row => row.format === format)
      report.byFormat[format] = {
        completed: completed.length,
        selectionRate: completed.filter(row => row.correct).length / completed.length,
        meanToolTokens: completed.reduce((sum,row) => sum + row.toolTokens, 0) / completed.length,
      }
      await writeFile(join(values.out,'report.json'),JSON.stringify(report,null,2)+'\n')
    }
  }
}
