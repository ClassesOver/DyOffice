import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { workspaceAliases } from '../../../apps/web/workspace-aliases.mjs'

export async function withEditorPage(entry, evaluate) {
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
  try {
    const page=await browser.newPage()
    await page.route('**/*',route=>route.abort())
    await page.setContent('<base href="https://eval.invalid/">')
    let scriptFailure
    page.on('pageerror',error=>{scriptFailure=error})
    await page.addScriptTag({content:bundle.outputFiles[0].text})
    if(scriptFailure)throw scriptFailure
    return await evaluate(page)
  } finally { await browser.close() }
}
