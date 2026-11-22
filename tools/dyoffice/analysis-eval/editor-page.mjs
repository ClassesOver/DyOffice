import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { resolve, join } from 'node:path'
import { workspaceAliases } from '../../../apps/web/workspace-aliases.mjs'

function bundle(entry, platform) {
  const aliases = workspaceAliases()
  return build({
    entryPoints:[entry], write:false, bundle:true, platform, format:platform==='node'?'esm':'iife', globalName:platform==='node'?undefined:'officeCatalog', treeShaking:true,
    ...(platform==='node'?{banner:{js:"import {createRequire as __createRequire} from 'node:module';const require=__createRequire(import.meta.url);"}}:{}),
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
}

/** Same contract as withEditorPage for executors that need Node (the PPTX
 * engine reads packages with node:zlib/crypto): `evaluate(fn, arg)` runs fn
 * with the module as the global officeCatalog. */
export async function withNodeModule(entry, evaluate) {
  const built = await bundle(entry, 'node')
  const directory = await mkdtemp(join(tmpdir(), 'dyoffice-eval-'))
  try {
    const file = join(directory, 'catalog.mjs')
    await writeFile(file, built.outputFiles[0].text)
    globalThis.window ??= globalThis
    globalThis.officeCatalog = await import(pathToFileURL(file).href)
    return await evaluate({ evaluate: async (fn, arg) => fn(arg) })
  } finally { delete globalThis.officeCatalog; await rm(directory, { recursive:true, force:true }) }
}

export async function withEditorPage(entry, evaluate) {
  const built = await bundle(entry, 'browser')
  const browser = await chromium.launch(process.env.DYOFFICE_TEST_CHROMIUM_PATH ? { executablePath:process.env.DYOFFICE_TEST_CHROMIUM_PATH } : {})
  try {
    const page=await browser.newPage()
    await page.route('**/*',route=>route.abort())
    await page.setContent('<base href="https://eval.invalid/">')
    let scriptFailure
    page.on('pageerror',error=>{scriptFailure=error})
    // The offline page is not a secure context, so randomUUID is missing;
    // editors use it for transaction and object IDs.
    await page.evaluate(()=>{if(!crypto.randomUUID)crypto.randomUUID=()=>{const b=crypto.getRandomValues(new Uint8Array(16));b[6]=b[6]&15|64;b[8]=b[8]&63|128;const h=[...b].map(x=>x.toString(16).padStart(2,'0')).join('');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`}})
    await page.addScriptTag({content:built.outputFiles[0].text})
    if(scriptFailure)throw scriptFailure
    return await evaluate(page)
  } finally { await browser.close() }
}
