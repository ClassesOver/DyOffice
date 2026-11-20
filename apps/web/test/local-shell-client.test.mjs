import test from 'node:test'
import assert from 'node:assert/strict'
import {createLocalShellClient} from '../src/shell/local-client.ts'
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}})
test('local login uses challenge then cookie session without bearer storage',async()=>{
 const calls=[];const client=createLocalShellClient(async(path,init)=>{calls.push({path,...init});return path.endsWith('/csrf')?json({csrfToken:'challenge'}):json({user:{id:'u'},csrfToken:'session'})})
 await client.login('alice','secret');assert.deepEqual(calls.map(c=>c.path),['/api/v1/auth/csrf','/api/v1/auth/login']);assert.equal(calls[1].headers['X-CSRF-Token'],'challenge');assert.equal(calls[1].credentials,'same-origin');assert.equal(calls[1].headers.Authorization,undefined)
})
test('caller cancellation prevents dispatch and cancels a live request without ending the session',async()=>{
 const calls=[],client=createLocalShellClient(async(path,init)=>{calls.push({path,...init});return new Promise((resolve,reject)=>init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true}))})
 const stopped=new AbortController();stopped.abort()
 await assert.rejects(client.request('/api/v1/preferences','GET',undefined,stopped.signal),{name:'AbortError'})
 assert.equal(calls.length,0)
 const active=new AbortController(),pending=client.request('/api/v1/preferences','GET',undefined,active.signal)
 await new Promise(resolve=>setImmediate(resolve));active.abort()
 await assert.rejects(pending,{name:'AbortError'})
 assert.equal(calls[0].signal.aborted,true)
})
test('caller cancellation during CSRF acquisition prevents the subsequent mutation even if fetch ignores abort',async()=>{
 let finish;const calls=[],client=createLocalShellClient(async(path,init)=>{calls.push({path,...init});return new Promise(resolve=>{finish=resolve})})
 const controller=new AbortController(),pending=client.request('/api/v1/preferences','PUT',{theme:'dark'},controller.signal)
 await new Promise(resolve=>setImmediate(resolve));controller.abort();finish(json({csrfToken:'c'.repeat(43)}))
 await assert.rejects(pending,{name:'AbortError'})
 assert.deepEqual(calls.map(call=>call.path),['/api/v1/auth/csrf'])
})
test('session-bound request cancels its response-proof check with the caller signal',async()=>{
 let finish,proofReads=0;const calls=[],proof='c'.repeat(43)
 const client=createLocalShellClient(async(path,init)=>{calls.push({path,...init});if(path.endsWith('/session-proof')){proofReads++;if(proofReads===2)return new Promise(resolve=>{finish=resolve});return json({csrfToken:proof})}return json({revision:1})})
 const bound=await client.bindSession(),controller=new AbortController(),pending=bound.request('/api/v1/preferences','GET',undefined,controller.signal)
 await new Promise(resolve=>setImmediate(resolve));controller.abort();finish(json({csrfToken:proof}))
 await assert.rejects(pending,{name:'AbortError'})
 assert.equal(calls.at(-1).signal.aborted,true)
})
test('preference mutation fetches csrf and never blindly retries failed writes',async()=>{
 const calls=[];const client=createLocalShellClient(async(path,init)=>{calls.push({path,...init});return path.endsWith('/csrf')?json({csrfToken:'session'}):json({title:'Forbidden'},403)})
 await assert.rejects(client.request('/api/v1/preferences','PUT',{theme:'dark'}),/Forbidden/);assert.equal(calls.length,2);assert.equal(calls[1].headers['X-CSRF-Token'],'session')
 await assert.rejects(client.request('https://evil.test/api/v1/auth/me'),/same-origin/);assert.equal(calls.length,2)
})
test('new API files paginate and map preferences without legacy endpoint fallback',async()=>{
 const calls=[];const client=createLocalShellClient(async(path)=>{calls.push(path);return path.includes('cursor=')?json({files:[{id:'b'}],nextCursor:null}):json({files:[{id:'a'}],nextCursor:'next'})})
 assert.deepEqual(await client.homeRequest('/files'),[{id:'a'},{id:'b'}]);assert.equal(calls[1],'/api/v1/files?limit=100&cursor=next');await assert.rejects(client.homeRequest('/unknown'),/Unsupported/)
})
test('upload stages exact bytes then finishes once; failed finish is not cancelled or retried',async()=>{
 const calls=[];const proof='a'.repeat(43)
 const client=createLocalShellClient(async(path,init)=>{calls.push({path,...init});if(path.endsWith('/session-proof'))return json({csrfToken:proof});if(path.endsWith('/files/uploads'))return json({uploadId:'up'});if(path.endsWith('/finish'))return json({title:'Unknown commit'},503);return new Response(null,{status:204})})
 const file=new File(['abc'],'a.docx');await assert.rejects(client.upload(file,proof),/Unknown commit/)
 const writes=calls.filter(c=>c.method!=='GET')
 assert.deepEqual(writes.map(c=>c.path),['/api/v1/files/uploads','/api/v1/uploads/up/content','/api/v1/uploads/up/finish'])
 assert.equal(writes[1].body,file);assert.equal(writes[2].body,undefined)
 assert.ok(writes.every(c=>c.headers['X-CSRF-Token']===proof))
 assert.equal(calls.filter(c=>c.path.endsWith('/session-proof')).length,3)
})
test('password change adopts rotated session CSRF; failures clear stale token without retry',async()=>{
 const calls=[];let fail=false;const client=createLocalShellClient(async(path,init)=>{calls.push({path,...init});if(path.endsWith('/csrf'))return json({csrfToken:'before'});if(path.endsWith('/change-password'))return fail?json({title:'Unauthorized'},401):json({csrfToken:'a'.repeat(43)});return json({theme:'dark'})})
 await client.changePassword('old password','new password');await client.request('/api/v1/preferences','PUT',{theme:'dark'});assert.equal(calls[2].headers['X-CSRF-Token'],'a'.repeat(43))
 assert.deepEqual(JSON.parse(calls[1].body),{currentPassword:'old password',newPassword:'new password'})
 fail=true;await assert.rejects(client.changePassword('wrong','new password'));assert.equal(calls.filter(c=>c.path.endsWith('change-password')).length,2)
 await client.request('/api/v1/preferences','PUT',{theme:'dark'});assert.equal(calls.at(-2).path,'/api/v1/auth/csrf')
})
test('another account action can invalidate cached CSRF without exposing it',async()=>{
 const calls=[];const client=createLocalShellClient(async(path,init)=>{calls.push({path,...init});return path.endsWith('/csrf')?json({csrfToken:'current'}):json({})})
 await client.request('/api/v1/preferences','PUT',{theme:'dark'});client.invalidateCsrf();await client.request('/api/v1/preferences','PUT',{theme:'light'});assert.equal(calls.filter(c=>c.path.endsWith('/csrf')).length,2)
})
test('password action lock survives UI replacement and ambiguous success payloads',{timeout:500},async()=>{
 let calls=0;let finish;const client=createLocalShellClient(async path=>{if(path.endsWith('/csrf'))return json({csrfToken:'c'.repeat(43)});calls++;return new Promise(r=>{finish=r})})
 const pending=client.changePassword('old','new');await new Promise(r=>setImmediate(r));await assert.rejects(client.changePassword('old','new'),/进行中/);assert.equal(calls,1)
 finish(json({}));await assert.rejects(pending,/无法确认/);await assert.rejects(client.changePassword('old','new'),/无法确认/);assert.equal(calls,1)
})

test('logout fences a delayed prior-user response even when the transport ignores cancellation',async()=>{
 let finish,oldSignal
 const client=createLocalShellClient(async(path,init)=>{
  if(path.endsWith('/csrf'))return json({csrfToken:'c'.repeat(43)})
  if(path.endsWith('/logout'))return new Response(null,{status:204})
  oldSignal=init.signal;return new Promise(resolve=>{finish=resolve})
 })
 const pending=client.request('/api/v1/admin/config').then(value=>({value}),error=>({error}))
 await new Promise(resolve=>setImmediate(resolve))
 await client.logout()
 finish(json({entries:[{label:'Alice private administration'}]}))
 const outcome=await pending
 assert.equal(outcome.error?.code,'stale_session')
 assert.equal(oldSignal?.aborted,true)
})

test('old CSRF response cannot dispatch a write after logout',async()=>{
 let firstCsrf,reads=0;const writes=[]
 const client=createLocalShellClient(async(path,init)=>{
  if(path.endsWith('/csrf')){reads++;return reads===1?new Promise(resolve=>{firstCsrf=resolve}):json({csrfToken:'new-session'})}
  writes.push(path);return new Response(null,{status:204})
 })
 const pending=client.request('/api/v1/preferences','PUT',{theme:'dark'}).then(value=>({value}),error=>({error}))
 await new Promise(resolve=>setImmediate(resolve))
 await client.logout();firstCsrf(json({csrfToken:'old-session'}))
 assert.equal((await pending).error?.code,'stale_session')
 assert.deepEqual(writes,['/api/v1/auth/logout'])
})

test('an observed expired session invalidates other in-flight data responses',async()=>{
 let finish
 const client=createLocalShellClient(async path=>path.endsWith('/me')?json({error:'Unauthorized'},401):new Promise(resolve=>{finish=resolve}))
 const pending=client.request('/api/v1/admin/config').then(value=>({value}),error=>({error}))
 await new Promise(resolve=>setImmediate(resolve))
 await assert.rejects(client.request('/api/v1/auth/me'),error=>error.status===401)
 finish(json({revision:7,entries:[]}))
 assert.equal((await pending).error?.code,'stale_session')
})

test('configuration conflicts keep the draft guidance without hiding other resource conflicts',async()=>{
 const client=createLocalShellClient(async()=>json({message:'文件夹非空，无法删除。'},409))
 await assert.rejects(client.request('/api/v1/workspace/folders/folder'),/非空目录/)
 await assert.rejects(client.request('/api/v1/admin/config'),/草稿已保留/)
})


test('file upload refuses a cookie rotated before the initiating workspace action',async()=>{
 let cookie='a';const writes=[]
 const client=createLocalShellClient(async(path,init)=>{
  if(path.endsWith('/session-proof')||path.endsWith('/csrf'))return json({csrfToken:cookie.repeat(43)})
  if(!['GET','HEAD'].includes(init.method)){
   if(init.headers['X-CSRF-Token']!==cookie.repeat(43))return json({error:'Forbidden'},403)
   writes.push({account:cookie,path})
  }
  if(path.endsWith('/files/uploads'))return json({uploadId:'up'})
  if(path.endsWith('/finish'))return json({file:{fileId:'created'}})
  return new Response(null,{status:204})
 })
 const workspace=await client.bindSession()
 cookie='b'
 const result=await client.upload(new File(['private A bytes'],'a.docx'),workspace.proof).then(value=>({value}),error=>({error}))
 assert.deepEqual(writes,[],'no private bytes or new files may be sent to the new cookie account')
 assert.equal(result.error?.code,'stale_session')
})

for(const rotateAfter of ['stage','content','finish'])test(`upload fences cookie rotation after ${rotateAfter} without replay or cross-account bytes`,async()=>{
 let cookie='a';const writes=[];const proof='a'.repeat(43)
 const client=createLocalShellClient(async(path,init)=>{
  if(path.endsWith('/session-proof'))return json({csrfToken:cookie.repeat(43)})
  assert.equal(init.headers['X-CSRF-Token'],proof)
  if(init.headers['X-CSRF-Token']!==cookie.repeat(43))return json({error:'Forbidden'},403)
  const phase=path.endsWith('/files/uploads')?'stage':path.endsWith('/content')?'content':'finish'
  writes.push({account:cookie,phase,body:init.body})
  if(phase===rotateAfter)cookie='b'
  return phase==='stage'?json({uploadId:'up'}):phase==='finish'?json({file:{fileId:'created'}}):new Response(null,{status:204})
 })
 const file=new File(['private A bytes'],'a.xlsx')
 await assert.rejects(client.upload(file,proof),{code:'stale_session'})
 const phases=['stage','content','finish'];assert.deepEqual(writes.map(w=>w.phase),phases.slice(0,phases.indexOf(rotateAfter)+1))
 assert.ok(writes.every(w=>w.account==='a'))
 if(rotateAfter!=='stage')assert.equal(writes[1].body,file)
})

test('upload without an initiating workspace proof makes no request',async()=>{
 let calls=0;const client=createLocalShellClient(async()=>{calls++;throw Error('must not call')})
 await assert.rejects(client.upload(new File(['x'],'a.pdf'),undefined),{code:'stale_session'})
 assert.equal(calls,0)
})
