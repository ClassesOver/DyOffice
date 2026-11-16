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
