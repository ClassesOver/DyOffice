import test from 'node:test'
import assert from 'node:assert/strict'
import {createApiShell} from '../../server/src/framework.ts'
import {registerAdminSyntheticProbe} from '../../server/src/modules/providers/synthetic-probe.ts'
const url='/api/v1/admin/ai/synthetic-probe',token='a'.repeat(43),headers={cookie:'__Host-dyoffice-session='+token}
const principal={deploymentId:'d',userId:'u',sessionId:'s',roles:['config_admin']}
for(const stage of ['session','principal'])test(`synthetic shutdown ends ${stage} wait without late success`,async()=>{
 let entered,release,calls=0
 const waiting=new Promise(r=>entered=r),gate=new Promise(r=>release=r)
 const app=await createApiShell()
 registerAdminSyntheticProbe(app,{sessions:{authenticate:async()=>{if(stage==='session'){entered();await gate}}},csrf:{requireSession(){}},transactions:{withPrincipalTransaction:async(_input,fn)=>{calls++;entered();await gate;return fn({},principal)}}})
 const work=app.inject({method:'POST',url,headers,payload:{}}).then(r=>r)
 await waiting
 let timer
 try{
  const [,result]=await Promise.race([Promise.all([app.close(),work]),new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('shutdown blocked')),500))])
  assert.equal(result.statusCode,403);assert.equal(calls,stage==='session'?0:1)
 }finally{clearTimeout(timer);release();await work;await app.close()}
 await new Promise(r=>setImmediate(r));assert.equal(calls,stage==='session'?0:1)
})
test('synthetic probe rechecks admin authority before its fixed response',async()=>{
 let calls=0
 const app=await createApiShell()
 registerAdminSyntheticProbe(app,{sessions:{authenticate:async()=>{}},csrf:{requireSession(){}},transactions:{withPrincipalTransaction:async(_input,fn)=>fn({}, {...principal,roles:++calls<4?principal.roles:[]})}})
 const r=await app.inject({method:'POST',url,headers,payload:{}})
 assert.equal(r.statusCode,403);assert.equal(calls,4)
 await app.close()
})
