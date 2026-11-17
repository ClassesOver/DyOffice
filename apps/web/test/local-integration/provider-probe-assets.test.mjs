import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {restrictedFixture} from '../helpers/restricted.mjs'
import {buildLocalApp} from '../../server/src/app.ts'
test('probe static assets require explicit pipeline and admin session with strict CSP',async t=>{
 const f=await restrictedFixture(t),dir=await mkdtemp(join(tmpdir(),'probe-assets-'));t.after(()=>rm(dir,{recursive:true,force:true}));await mkdir(join(dir,'.vite'));await mkdir(join(dir,'assets'));await writeFile(join(dir,'index.html'),'<main>synthetic</main>');await writeFile(join(dir,'legacy.html'),'legacy');await writeFile(join(dir,'pdf.html'),'pdf');await writeFile(join(dir,'assets/probe.js'),'console.log("synthetic")');await writeFile(join(dir,'.vite/manifest.json'),JSON.stringify({'index.html':{file:'assets/probe.js'}}))
 const base={db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin:'https://office.example',csrfKey:f.csrfKey,adminProviderProbeDirectory:dir}
 await assert.rejects(buildLocalApp(base))
 const profile={deploymentId:f.deploymentId,entryId:'primary',revision:1,providerId:'openai',model:'synthetic',baseUrl:'https://provider.example/v1',endpoint:'https://provider.example/v1/chat/completions',allowedIpv4:['8.8.8.8'],maxOutputTokens:128}
 const app=await buildLocalApp({...base,adminProviderProbe:{profiles:[profile]},globalConfigKeyring:{activeKeyId:'k1',keys:{k1:new Uint8Array(32).fill(71)}}});f.cleanup.push(()=>app.close())
 for(const path of ['/admin/provider-probe/','/admin/provider-probe/assets/probe.js']){
  assert.equal((await app.inject({url:path})).statusCode,401)
  assert.equal((await app.inject({url:path,headers:{cookie:'__Host-dyoffice-session='+f.alice.token}})).statusCode,403)
  const r=await app.inject({url:path,headers:{cookie:'__Host-dyoffice-session='+f.adminSigned.token}});assert.equal(r.statusCode,200);assert.match(r.headers['content-security-policy'],/default-src 'none'/);assert.doesNotMatch(r.headers['content-security-policy'],/unsafe-/);assert.match(r.headers['cache-control'],/no-store/)
 }
 assert.equal((await app.inject({url:'/admin/provider-probe/assets/probe.js.map',headers:{cookie:'__Host-dyoffice-session='+f.adminSigned.token}})).statusCode,404)
 for(const other of ['legacy.html','pdf.html'])assert.equal((await app.inject({url:'/admin/provider-probe/'+other,headers:{cookie:'__Host-dyoffice-session='+f.adminSigned.token}})).statusCode,404)
 assert.equal((await f.app.inject({url:'/admin/provider-probe/'})).statusCode,404)
})
