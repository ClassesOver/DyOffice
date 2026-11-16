import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createApiShell} from '../../server/src/framework.ts'
import {createStaticAssets} from '../../server/static-assets.mjs'
import {registerProbeAssets} from '../../server/src/modules/providers/probe-assets.ts'
import {authError} from '../../server/src/modules/auth/sessions.ts'
test('built probe HTML/assets require live authorization on GET/HEAD and whitelist pages',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'probe83-assets-'));t.after(()=>rm(dir,{recursive:true,force:true}));await mkdir(join(dir,'.vite'));await mkdir(join(dir,'assets'))
 for(const [name,body] of Object.entries({'index.html':'<main>probe</main>','legacy.html':'legacy','assets/probe.js':'void 0','assets/probe.js.map':'source','.vite/manifest.json':JSON.stringify({'index.html':{file:'assets/probe.js'}})}))await writeFile(join(dir,name),body)
 const assets=await createStaticAssets({assetMode:'built',assetDirectory:dir,pages:['index.html'],cacheControl:'private, no-store'})
 const app=await createApiShell();t.after(()=>app.close());let allowed=true,calls=0
 registerProbeAssets(app,assets,async token=>{calls++;if(token!=='a'.repeat(43)||!allowed)throw authError(403)})
 const headers={cookie:'__Host-dyoffice-session='+'a'.repeat(43)}
 for(const method of ['GET','HEAD'])for(const url of ['/admin/provider-probe/','/admin/provider-probe/assets/probe.js']){
  assert.equal((await app.inject({method,url})).statusCode,401)
  const r=await app.inject({method,url,headers});assert.equal(r.statusCode,200);assert.match(r.headers['cache-control'],/no-store/);assert.match(r.headers['content-security-policy'],/frame-ancestors 'none'/);assert.doesNotMatch(r.headers['content-security-policy'],/unsafe-/)
 }
 for(const path of ['legacy.html','assets/probe.js.map','.vite/manifest.json'])assert.equal((await app.inject({url:'/admin/provider-probe/'+path,headers})).statusCode,404)
 allowed=false;assert.equal((await app.inject({url:'/admin/provider-probe/',headers})).statusCode,403);assert.equal(calls,8)
})
