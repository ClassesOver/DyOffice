import {test} from 'node:test'
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {readFile,mkdtemp,rm,stat} from 'node:fs/promises'
import {dirname,join} from 'node:path'
import {tmpdir} from 'node:os'
import {fileURLToPath} from 'node:url'
import {createRequire} from 'node:module'
import {createStaticAssets} from '../../server/static-assets.mjs'
const web=fileURLToPath(new URL('../../',import.meta.url))
const vite=join(dirname(createRequire(import.meta.url).resolve('vite/package.json')),'bin/vite.js')
test('real PPTX build inventory contains only final files and can initialize the strict static server',async()=>{
 const output=await mkdtemp(join(tmpdir(),'slides-inventory-build-'))
 try{
  execFileSync(process.execPath,[vite,'build','--config',join(web,'vite.slides.config.ts'),'--outDir',output],{cwd:web,stdio:'pipe',timeout:120000})
  const inventory=JSON.parse(await readFile(join(output,'.vite/native-assets.json'),'utf8'))
  assert.ok(inventory.length>0)
  for(const name of inventory)assert.ok((await stat(join(output,name))).isFile(),name)
  const serve=await createStaticAssets({assetMode:'built',assetDirectory:output,pages:['index.html'],assetInventory:'.vite/native-assets.json'})
  for(const path of ['/',...inventory.map(name=>'/'+name)]){
   let status,body
   assert.equal(await serve({method:'GET'},{writeHead(value){status=value},end(value){body=value}},path),true,path)
   assert.equal(status,200,path);assert.ok(body.length>0,path)
  }
 }finally{await rm(output,{recursive:true,force:true})}
})
