import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {createLocalWorkspaceSession} from '../src/shell/local-workspace-session.ts'
import {localSessionsClient} from '../src/shell/local-sessions-client.ts'
const A='a'.repeat(43),B='b'.repeat(43)
function fixture(){let ended;return {client:{onSessionEnded(fn){ended=fn},endSession(){ended()},async bindSession(){throw Object.assign(Error('stale'),{code:'stale_session'})}}}}
test('unbound workspace and default session panel cannot send requests',async()=>{
 const {client}=fixture(),scope=createLocalWorkspaceSession(client)
 await assert.rejects(scope.request('/api/v1/workspace/folders','POST'),{code:'stale_session'})
 await assert.rejects(scope.sessionFetch('/api/v1/auth/csrf'),{code:'stale_session'})
 await assert.rejects(localSessionsClient.listPage(),{code:'stale_session'})
})
for(const method of ['GET','POST'])test(`late ${method} result after verified rebind cannot acknowledge old operation`,async()=>{
 const {client}=fixture(),scope=createLocalWorkspaceSession(client);let finish
 scope.bind({proof:A,request:()=>new Promise(resolve=>finish=resolve)})
 const pending=scope.request('/api/v1/workspace/folders',method)
 scope.bind({proof:B,request:async()=>({newer:true})});finish({old:true})
 await assert.rejects(pending,error=>method==='GET'?error.code==='stale_session':error.status===undefined&&/尚未确认/.test(error.message))
})
test('rebind between CSRF read and revoke cannot adopt the new session for old intent',async()=>{
 const {client}=fixture(),scope=createLocalWorkspaceSession(client);let calls=0
 scope.bind({proof:B,request:async()=>{calls++;return undefined}})
 await assert.rejects(scope.sessionFetch('/api/v1/auth/sessions/revoke-others',{method:'POST',headers:{'X-CSRF-Token':A}}),{code:'stale_session'})
 assert.equal(calls,0)
})
test('bodyless adapter preserves exact no-content and rejects unrelated transport',async()=>{
 const {client}=fixture(),scope=createLocalWorkspaceSession(client);let calls=0
 scope.bind({proof:A,request:async()=>{calls++;return undefined}})
 assert.equal((await scope.sessionFetch('/api/v1/auth/sessions/revoke-others',{method:'POST',headers:{'X-CSRF-Token':A}})).status,204)
 for(const [path,init] of [['https://other.example',{}],['/api/v1/admin/users',{}],['/api/v1/auth/sessions',{method:'POST',body:'x'}]])await assert.rejects(scope.sessionFetch(path,init))
 assert.equal(calls,1)
})
test('session end invalidates binding without admitting a new cookie',async()=>{
 const {client}=fixture(),scope=createLocalWorkspaceSession(client);let calls=0
 scope.bind({proof:A,request:async()=>{calls++;return {}}});client.endSession()
 await assert.rejects(scope.request('/api/v1/workspace/folders'),{code:'stale_session'});assert.equal(calls,0)
})
test('production keeps stable clients and binds only restored or identity-checked workspace',async()=>{
 const source=await readFile(new URL('../src/shell/local-main.tsx',import.meta.url),'utf8')
 assert.match(source,/createLocalSessionsClient\(workspaceSession\.sessionFetch,/)
 assert.match(source,/createLocalHomeBridge\(\{request:workspaceSession\.request,/)
 assert.equal(source.match(/workspaceSession\.bind\(bound\)/g)?.length,2)
 const update=source.slice(source.indexOf('async function updateSession('),source.indexOf(" if(page==='settings'"))
 assert.ok(update.indexOf('identity.user.id!==user?.id')<update.indexOf('workspaceSession.bind(bound)'))
})
