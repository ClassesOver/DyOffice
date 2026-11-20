import {test} from 'node:test'
import assert from 'node:assert/strict'
import {randomBytes,randomUUID} from 'node:crypto'
import {createServer} from 'node:http'
import {restrictedFixture,restrictedOrigin} from '../helpers/restricted.mjs'
import {createLocalShellClient} from '../../src/shell/local-client.ts'
import {createSourceWorkspaceSession} from '../../src/shell/source-workspace-session.ts'

async function fixture(t){
 const source=createServer((_q,r)=>{r.setHeader('content-type','application/json');r.end(JSON.stringify([{amount:42,text:'=literal',unicode:'收入'}]))})
 await new Promise(r=>source.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{source.closeAllConnections();source.close(r)}))
 const sourceUrl='http://127.0.0.1:'+source.address().port+'/data'
 const f=await restrictedFixture(t,{sourcesCredentialKeys:'k1:'+randomBytes(32).toString('base64'),sourcesEgressTargets:[{kind:'http',endpoint:sourceUrl,addresses:['127.0.0.1'],allowInsecure:true}]})
 const address=await f.app.listen({host:'127.0.0.1',port:0})
 let cookie=f.alice.token,hold
 const calls=[]
 const send=async(path,init={})=>{
  calls.push({path,proof:new Headers(init.headers).get('x-csrf-token')})
  const response=await fetch(address+path,{...init,headers:{...init.headers,origin:restrictedOrigin,cookie:'__Host-dyoffice-session='+cookie}})
  if(hold&&path.startsWith('/api/v1/sources'))await hold()
  return response
 }
 const local=createLocalShellClient(send),workspace=await createSourceWorkspaceSession(local)
 return {...f,local,workspace,calls,sourceUrl,address,switchToBob(){cookie=f.bob.token},holdReply(fn){hold=fn}}
}
const draft=id=>({sourceId:id,name:'Alice draft',kind:'http',config:{},secret:'https://example.com/private'})

test('actual HTTP cross-tab cookie replacement cannot publish old source draft or retry with new CSRF',async t=>{
 const f=await fixture(t)
 await f.workspace.sources.create(draft('alice-before'))
 f.switchToBob()
 for(let i=0;i<2;i++)await assert.rejects(f.workspace.sources.create(draft('alice-after')),{status:403})
 const bob=await createSourceWorkspaceSession(f.local)
 assert.deepEqual((await bob.sources.list()).items,[])
 assert.equal(f.calls.filter(x=>x.path==='/api/v1/auth/csrf').length,0)
})
test('actual HTTP old source/result clients reject cross-tab reads and result writes',async t=>{
 const f=await fixture(t);f.switchToBob()
 await assert.rejects(f.workspace.sources.list())
 await assert.rejects(f.workspace.results.list(),e=>e.code==='stale_session'||e.status===403)
 for(let i=0;i<2;i++)await assert.rejects(f.workspace.results.save(randomUUID(),'Alice result',randomUUID()),{status:403})
})
test('actual HTTP source response completed before cross-tab switch is withheld after it',async t=>{
 const f=await fixture(t)
 let release,arrived
 const ready=new Promise(r=>arrived=r),gate=new Promise(r=>release=r)
 f.holdReply(async()=>{arrived();await gate})
 const reading=f.workspace.sources.list();await ready;f.switchToBob();release()
 await assert.rejects(reading)
})

test('actual frozen JSON download keeps canonical server bytes and rejects a replaced cookie',async t=>{
 const f=await fixture(t)
 const created=await f.workspace.sources.create({sourceId:'download',name:'Download',kind:'http',config:{},secret:f.sourceUrl})
 const capture=await f.workspace.results.query('download',{})
 const saved=await f.workspace.results.save(capture.artifact.resultId,'Frozen',randomUUID())
 const response=await fetch(f.address+'/api/v1/workspace/data-results/'+saved.resultId+'/content',{headers:{cookie:'__Host-dyoffice-session='+f.alice.token}})
 assert.equal(response.status,200)
 const canonical=await response.text()
 assert.equal(await f.workspace.results.download(saved.resultId),canonical)
 assert.equal(Buffer.byteLength(canonical),saved.sizeBytes)
 f.switchToBob();await assert.rejects(f.workspace.results.download(saved.resultId))
})
