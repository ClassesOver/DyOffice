import {build} from 'esbuild'
import {mkdir,chmod,rename,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {dirname,join,resolve} from 'node:path'

const root=fileURLToPath(new URL('../../',import.meta.url))
const output=resolve(process.argv[2]??join(root,'.dyoffice-analysis-build/harness-data.mjs'))
if(process.argv.length>3)throw Error('Usage: node tools/analysis-runtime/build-harness-data-helper.mjs [output.mjs]')
await mkdir(dirname(output),{recursive:true})
const temporary=output+'.'+process.pid+'.tmp'
try {
await build({entryPoints:[join(root,'packages/cli/src/harness-data-helper.ts')],outfile:temporary,bundle:true,
  platform:'node',target:'node22',format:'esm',banner:{js:'#!/usr/bin/env node'},sourcemap:false,logLevel:'silent'})
await chmod(temporary,0o555)
await rename(temporary,output)
} finally {await rm(temporary,{force:true})}
console.log('Harness data helper: '+output)
