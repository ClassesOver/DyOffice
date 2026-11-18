import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {runInNewContext} from 'node:vm'
import {fileFixture} from '../helpers/files.mjs'
import {restrictedOrigin} from '../helpers/restricted.mjs'
import {createLocalShellClient} from '../../src/shell/local-client.ts'
import {createLocalWorkspaceSession} from '../../src/shell/local-workspace-session.ts'
import {createLocalHomeBridge} from '../../src/shell/local-home-bridge.ts'
const source=await readFile(new URL('../../src/shell/local-main.tsx',import.meta.url),'utf8')
const selected=source.match(/createLocalHomeBridge\(\{request:([^,]+),/)
assert.ok(selected)
test('existing Home must not create a folder under replacement cookie owner',async t=>{
 const f=await fileFixture(t),address=await f.app.listen({host:'127.0.0.1',port:0});let cookie=f.alice.token
 const client=createLocalShellClient((path,init={})=>fetch(address+path,{...init,headers:{...init.headers,origin:restrictedOrigin,cookie:'__Host-dyoffice-session='+cookie}}))
 const bound=await client.bindSession()
 const workspaceSession=createLocalWorkspaceSession(client);workspaceSession.bind(bound)
 const request=runInNewContext(selected[1],{client,sourceWorkspace:{bound},workspaceSession})
 const bridge=createLocalHomeBridge({request,preferences:{getPreferences:async()=>({language:'en'})},open:async()=>{},browse:async()=>{},openTrash(){},changed(){},unsupported(){}})
 cookie=f.bob.token
 const result=await bridge.createFolder('/workspace','Alice intended folder').then(value=>({value}),error=>({error:String(error)}))
 const folders=async token=>(await (await fetch(address+'/api/v1/workspace/folders',{headers:{origin:restrictedOrigin,cookie:'__Host-dyoffice-session='+token}})).json()).folders
 const alice=await folders(f.alice.token),bob=await folders(f.bob.token)
 t.diagnostic(JSON.stringify({result,aliceCount:alice.length,bobNames:bob.map(x=>x.name)}))
 assert.equal(bob.length,0,'Alice workspace intent must never create Bob folder')
})

test('old account security view must not revoke replacement account sessions',async t=>{
 const {createLocalSessionsClient}=await import('../../src/shell/local-sessions-client.ts')
 const {password}=await import('../helpers/identity.mjs')
 const f=await fileFixture(t),address=await f.app.listen({host:'127.0.0.1',port:0})
 const bobOther=await f.sessions.login('bob',password)
 let cookie=f.alice.token
 const send=(path,init={})=>fetch(address+path,{...init,headers:{...init.headers,origin:restrictedOrigin,cookie:'__Host-dyoffice-session='+cookie}})
 const shell=createLocalShellClient(send),workspaceSession=createLocalWorkspaceSession(shell);workspaceSession.bind(await shell.bindSession())
 const client=createLocalSessionsClient(workspaceSession.sessionFetch)
 await client.listPage()
 cookie=f.bob.token
 const outcome=await client.revokeOthers().then(()=>({ok:true}),error=>({error:String(error)}))
 const auth=await f.sessions.authenticate(bobOther.token).then(()=>({ok:true}),error=>({status:error.statusCode}))
 t.diagnostic(JSON.stringify({outcome,bobOtherSession:auth}))
 assert.equal(auth.ok,true,'Bob other session must remain active after Alice security-page intent')
})

async function scopedFixture(t){
 const {createLocalSessionsClient}=await import('../../src/shell/local-sessions-client.ts')
 const {password}=await import('../helpers/identity.mjs')
 const f=await fileFixture(t),address=await f.app.listen({host:'127.0.0.1',port:0})
 const other=await f.sessions.login('alice',password)
 let cookie=f.alice.token,rotatePath;const writes=[]
 const shell=createLocalShellClient(async(path,init={})=>{
  if(!['GET','HEAD'].includes(init.method??'GET'))writes.push(path)
  const response=await fetch(address+path,{...init,headers:{...init.headers,origin:restrictedOrigin,cookie:'__Host-dyoffice-session='+cookie}})
  if(path===rotatePath)cookie=f.bob.token
  return response
 })
 const scope=createLocalWorkspaceSession(shell);scope.bind(await shell.bindSession())
 const sessions=createLocalSessionsClient(scope.sessionFetch)
 return {...f,other,shell,scope,sessionClient:sessions,writes,rotateAfter(path){rotatePath=path},setCookie(token){cookie=token}}
}
test('bound session revokeOthers succeeds only for the original owner',async t=>{
 const f=await scopedFixture(t)
 await f.sessionClient.revokeOthers()
 await assert.rejects(f.sessions.authenticate(f.other.token))
})
test('committed revoke followed by cookie rotation stays unknown and stale read cannot unlock resend',async t=>{
 const f=await scopedFixture(t),path='/api/v1/auth/sessions/revoke-others';f.rotateAfter(path)
 await assert.rejects(f.sessionClient.revokeOthers())
 await assert.rejects(f.sessions.authenticate(f.other.token))
 await assert.rejects(f.sessionClient.list())
 await assert.rejects(f.sessionClient.revokeOthers(),/进行中或结果未知/)
 assert.deepEqual(f.writes,[path])
 await f.sessions.authenticate(f.bob.token)
})
test('late session list after cookie rotation never returns replacement evidence',async t=>{
 const f=await scopedFixture(t);f.rotateAfter('/api/v1/auth/sessions')
 await assert.rejects(f.sessionClient.list(),{code:'stale_session'})
 assert.deepEqual(f.writes,[])
})
test('folder committed before cookie change cannot return success to obsolete workspace',async t=>{
 const f=await scopedFixture(t),path='/api/v1/workspace/folders';f.rotateAfter(path)
 const bridge=createLocalHomeBridge({request:f.scope.request,preferences:{getPreferences:async()=>({language:'en'})},open:async()=>{},browse:async()=>{},openTrash(){},changed(){},unsupported(){}})
 await assert.rejects(bridge.createFolder('/workspace','original-owner-folder'),{code:'stale_session'})
 assert.deepEqual(f.writes,[path])
 const rows=await f.transactions.withPrincipalTransaction({kind:'session',token:f.alice.token},c=>c.query('SELECT name FROM workspace_folders'))
 assert.deepEqual(rows.rows.map(r=>r.name),['original-owner-folder'])
})
test('verified same-user rebinding keeps the same session client usable',async t=>{
 const {password}=await import('../helpers/identity.mjs')
 const f=await scopedFixture(t),fresh=await f.sessions.login('alice',password)
 f.setCookie(fresh.token)
 const bound=await f.shell.bindSession()
 assert.equal((await bound.request('/api/v1/auth/me')).user.id,f.alice.user.id)
 f.scope.bind(bound)
 await f.sessionClient.revokeOthers()
 await f.sessions.authenticate(fresh.token)
 await assert.rejects(f.sessions.authenticate(f.other.token))
 await f.sessions.authenticate(f.bob.token)
 assert.equal(f.writes.length,1)
})
