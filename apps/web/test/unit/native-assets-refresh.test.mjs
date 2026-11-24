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

test('native editor scripts negotiate lossless Brotli, including HEAD and changed asset bytes',async t=>{
 const {brotliDecompressSync}=await import('node:zlib')
 const dir=await mkdtemp(join(tmpdir(),'native-assets-br-'));t.after(()=>rm(dir,{recursive:true,force:true}))
 await mkdir(join(dir,'.vite'));await mkdir(join(dir,'assets'))
 await writeFile(join(dir,'index.html'),'editor')
 await writeFile(join(dir,'.vite/manifest.json'),JSON.stringify({entry:{file:'assets/editor.js'}}))
 await writeFile(join(dir,'.vite/native-assets.json'),'[]')
 const original='void 0;\n'.repeat(8000),file=join(dir,'assets/editor.js')
 await writeFile(file,original)
 const serve=await createRefreshableStaticAssets({assetMode:'built',assetDirectory:dir,pages:['index.html'],assetInventory:'.vite/native-assets.json',cacheControl:'private, no-store'})
 async function call(encoding,method='GET'){
  let headers,body
  await serve({method,headers:{'accept-encoding':encoding}},{writeHead(status,h){assert.equal(status,200);headers=new Headers(Object.entries(h).map(([k,v])=>[k,String(v)]))},end(value){body=value}},'/assets/editor.js')
  return {headers,body}
 }
 const br=await call('gzip, br')
 assert.equal(br.headers.get('content-encoding'),'br')
 assert.equal(br.headers.get('vary'),'Accept-Encoding')
 assert.equal(br.headers.get('cache-control'),'private, no-store')
 assert.equal(brotliDecompressSync(br.body).toString(),original);assert.ok(br.body.length<original.length)
 const head=await call('br','HEAD');assert.equal(head.headers.get('content-length'),String(br.body.length));assert.equal(head.body,undefined)
 const plain=await call('br;q=0, *;q=1');assert.equal(plain.headers.get('content-encoding'),null);assert.equal(plain.body.toString(),original)
 const changed=original.replaceAll('0','1');await writeFile(file,changed)
 assert.equal(brotliDecompressSync((await call('br')).body).toString(),changed)
})
