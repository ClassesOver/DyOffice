import {expect,test,vi} from 'vitest'
import {createLocalShellClient} from '../../src/shell/local-client'
import {createLocalAdminClient} from '../../src/shell/local-admin-client'
import {createLocalWorkspaceSession} from '../../src/shell/local-workspace-session'
test('expired API sessions notify the shell and invalidate bound requests, including a non-JSON 401',async()=>{
 let expired=false
 const send=vi.fn(async(path:RequestInfo|URL)=>String(path).endsWith('session-proof')?new Response(JSON.stringify({csrfToken:'p'.repeat(43)})):expired?new Response('expired',{status:401}):new Response('{}'))
 const client=createLocalShellClient(send),notify=vi.fn(),unsubscribe=client.onSessionEnded(notify)
 const bound=await client.bindSession();expired=true
 await expect(client.request('/api/v1/preferences')).rejects.toMatchObject({status:401})
 expect(notify).toHaveBeenCalledWith('expired')
 const calls=send.mock.calls.length;await expect(bound.request('/api/v1/skills')).rejects.toMatchObject({code:'stale_session'});expect(send).toHaveBeenCalledTimes(calls)
 unsubscribe();await expect(client.request('/api/v1/preferences')).rejects.toMatchObject({status:401});expect(notify).toHaveBeenCalledTimes(1)
})
test('wrong login/current password and forbidden requests keep the active UI session',async()=>{
 let status=401
 const client=createLocalShellClient(async path=>String(path).endsWith('/csrf')?new Response(JSON.stringify({csrfToken:'p'.repeat(43)})):String(path).endsWith('/me')?new Response('{}'):new Response('{}',{status})),notify=vi.fn();client.onSessionEnded(notify)
 await expect(client.login('wrong','wrong')).rejects.toMatchObject({status:401})
 await expect(client.changePassword('wrong','long new passphrase')).rejects.toMatchObject({status:401})
 status=403;await expect(client.request('/api/v1/preferences')).rejects.toMatchObject({status:403});expect(notify).not.toHaveBeenCalled()
})
test('uncertain logout notifies recovery without automatically retrying the logout',async()=>{
 const send=vi.fn(async path=>String(path).endsWith('/csrf')?new Response(JSON.stringify({csrfToken:'p'.repeat(43)})):new Response('{}',{status:500}))
 const client=createLocalShellClient(send),notify=vi.fn();client.onSessionEnded(notify)
 await expect(client.logout()).rejects.toMatchObject({status:500})
 expect(notify).toHaveBeenCalledWith('logout_failed');expect(send.mock.calls.filter(([path])=>String(path).endsWith('/logout'))).toHaveLength(1)
})
test('invalidating a pending workspace read does not interrupt logout',async()=>{
 const send=vi.fn(async(path:RequestInfo|URL,init?:RequestInit)=>{
  if(String(path).endsWith('/logout'))return new Response(null,{status:204})
  if(String(path).endsWith('/files'))return new Promise<Response>((_resolve,reject)=>{
   const signal=init!.signal!;signal.addEventListener('abort',()=>reject(signal.reason),{once:true})
  })
  return new Response(JSON.stringify({csrfToken:'p'.repeat(43)}))
 })
 const client=createLocalShellClient(send),workspace=createLocalWorkspaceSession(client),notify=vi.fn()
 client.onSessionEnded(notify);workspace.bind(await client.bindSession())
 const pending=expect(workspace.request('/api/v1/files')).rejects.toMatchObject({code:'stale_session'})
 const outcome=await client.logout().then(()=>null,error=>error)
 await pending
 expect(outcome).toBeNull();expect(send.mock.calls.filter(([path])=>String(path).endsWith('/logout'))).toHaveLength(1)
 expect(notify).not.toHaveBeenCalled()
})
test('independent admin requests notify 401 only when identity is no longer available',async()=>{
 let expired=false
 const notify=vi.fn(),send=vi.fn(async(path:RequestInfo|URL)=>String(path).endsWith('/csrf')?new Response(JSON.stringify({csrfToken:'x'})):String(path).endsWith('/me')?new Response('{}',{status:expired?401:200}):new Response('{}',{status:401}))
 const client=createLocalAdminClient(send,notify)
 await expect(client.reauthenticate('wrong')).rejects.toMatchObject({status:401});expect(notify).not.toHaveBeenCalled()
 expired=true;await expect(client.reauthenticate('wrong')).rejects.toMatchObject({status:401});expect(notify).toHaveBeenCalledOnce()
 notify.mockClear();await expect(client.list()).rejects.toMatchObject({status:401});expect(notify).toHaveBeenCalledOnce()
})

for(const failure of [403,401,'network'] as const)test(`successful bound write followed by proof ${failure} stays an uncertain stale session`,async()=>{
 let proofReads=0,writes=0
 const client=createLocalShellClient(async(_path,init)=>{if(init?.method==='POST'){writes++;return new Response(JSON.stringify({saved:true}))}proofReads++;if(proofReads===1)return new Response(JSON.stringify({csrfToken:'p'.repeat(43)}));if(failure==='network')throw Error('offline');return new Response('{}',{status:failure})}),ended=vi.fn();client.onSessionEnded(ended)
 const bound=await client.bindSession()
 const error=await bound.request('/api/v1/sources/a','POST',{}).catch(error=>error)
 expect(error).toMatchObject({code:'stale_session',cause:expect.any(Error)});expect(error.status).toBeUndefined()
 expect(writes).toBe(1)
 if(failure===401)expect(ended).toHaveBeenCalledWith('expired')
})
test('primary bound write rejection retains its HTTP status and is not relabeled as uncertain',async()=>{
 const client=createLocalShellClient(async(_path,init)=>init?.method==='POST'?new Response('{}',{status:403}):new Response(JSON.stringify({csrfToken:'p'.repeat(43)})))
 const bound=await client.bindSession();await expect(bound.request('/api/v1/sources/a','POST',{})).rejects.toMatchObject({status:403})
})

for(const kind of ['sessions','history'] as const)test(`${kind} reads notify expired sessions but preserve forbidden errors`,async()=>{
 const {createLocalSessionsClient}=await import('../../src/shell/local-sessions-client')
 const {createLoginHistoryClient}=await import('../../src/shell/local-login-history-client')
 let status=401;const notify=vi.fn(),send=vi.fn(async()=>new Response('{}',{status}))
 const client=kind==='sessions'?createLocalSessionsClient(send,notify):createLoginHistoryClient(send,notify)
 await expect(client.list()).rejects.toThrow();expect(notify).toHaveBeenCalledOnce()
 notify.mockClear();status=403;await expect(client.list()).rejects.toThrow();expect(notify).not.toHaveBeenCalled()
})

for(const identity of [200,401,'network'] as const)test(`change-password 401 checks identity ${identity} before deciding session recovery`,async()=>{
 const notify=vi.fn(),paths:string[]=[]
 const client=createLocalShellClient(async(path)=>{paths.push(String(path));if(String(path).endsWith('/csrf'))return new Response(JSON.stringify({csrfToken:'p'.repeat(43)}));if(String(path).endsWith('/me')){if(identity==='network')throw Error('offline');return new Response('{}',{status:identity})}return new Response('{}',{status:401})});client.onSessionEnded(notify)
 await expect(client.changePassword('wrong','new long password')).rejects.toMatchObject({status:401})
 expect(paths).toContain('/api/v1/auth/me')
 if(identity===401)expect(notify).toHaveBeenCalledWith('expired');else expect(notify).not.toHaveBeenCalled()
})

test('bound file download rejects bytes returned after a cookie rotation',async()=>{
 const path='/api/v1/files/file/content?revision=revision&download=1'
 let proof='p'.repeat(43),rotate=false
 const send=vi.fn(async(input:RequestInfo|URL)=>{
  if(input==='/api/v1/auth/session-proof')return new Response(JSON.stringify({csrfToken:proof}))
  expect(input).toBe(path)
  if(rotate)proof='r'.repeat(43)
  return new Response('saved file bytes',{headers:{'Content-Type':'application/octet-stream'}})
 })
 const bound=await createLocalShellClient(send).bindSession()
 const saved=await bound.download(path)
 expect(await saved.text()).toBe('saved file bytes')
 rotate=true
 await expect(bound.download(path)).rejects.toMatchObject({code:'stale_session'})
})
