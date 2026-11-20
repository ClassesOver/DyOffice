import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createRefreshableStaticAssets} from '../../server/static-assets.mjs'

test('native build assets refresh after a rebuild while rejecting unlisted files',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'native-assets-'))
 t.after(()=>rm(dir,{recursive:true,force:true}))
 await mkdir(join(dir,'.vite'));await mkdir(join(dir,'assets'))
 await writeFile(join(dir,'index.html'),'editor')
 await writeFile(join(dir,'assets/old.js'),'old')
 await writeFile(join(dir,'.vite/manifest.json'),JSON.stringify({entry:{file:'assets/old.js'}}))
 await writeFile(join(dir,'.vite/native-assets.json'),'[]')
 const serve=await createRefreshableStaticAssets({assetMode:'built',assetDirectory:dir,pages:['index.html'],assetInventory:'.vite/native-assets.json'})
 const request={method:'GET'}
 const response={writeHead(){},end(){}}
 assert.equal(await serve(request,response,'/assets/old.js'),true)
 await writeFile(join(dir,'assets/new.js'),'new')
 await writeFile(join(dir,'.vite/manifest.json'),JSON.stringify({entry:{file:'assets/new.js'}}))
 assert.equal(await serve(request,response,'/assets/new.js'),true)
 assert.equal(await serve(request,response,'/assets/old.js'),false)
})
