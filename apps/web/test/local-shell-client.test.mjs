import test from 'node:test'
import assert from 'node:assert/strict'
import {createLocalShellClient} from '../src/shell/local-client.ts'
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}})
test('local login uses challenge then cookie session without bearer storage',async()=>{
 const calls=[];const client=createLocalShellClient(async(path,init)=>{calls.push({path,...init});return path.endsWith('/csrf')?json({csrfToken:'challenge'}):json({user:{id:'u'},csrfToken:'session'})})
 await client.login('alice','secret');assert.deepEqual(calls.map(c=>c.path),['/api/v1/auth/csrf','/api/v1/auth/login']);assert.equal(calls[1].headers['X-CSRF-Token'],'challenge');assert.equal(calls[1].credentials,'same-origin');assert.equal(calls[1].headers.Authorization,undefined)
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
 const calls=[];const client=createLocalShellClient(async(path,init)=>{calls.push({path,...init});if(path.endsWith('/csrf'))return json({csrfToken:'session'});if(path.endsWith('/files/uploads'))return json({uploadId:'up'});if(path.endsWith('/finish'))return json({title:'Unknown commit'},503);return new Response(null,{status:204})})
 const file=new File(['abc'],'a.docx');await assert.rejects(client.upload(file),/Unknown commit/);assert.deepEqual(calls.map(c=>c.path),['/api/v1/auth/csrf','/api/v1/files/uploads','/api/v1/uploads/up/content','/api/v1/uploads/up/finish']);assert.equal(calls[2].body,file);assert.equal(calls[3].body,undefined)
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
