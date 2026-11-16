import test from 'node:test'
import assert from 'node:assert/strict'
import {createLocalSessionsClient} from '../src/shell/local-sessions-client.ts'
const id='11111111-1111-4111-8111-111111111111'
const session={id,current:true,createdAt:'2026-11-16T00:00:00Z',lastSeenAt:'2026-11-16T00:00:00Z',expiresAt:'2026-11-17T00:00:00Z'}
const json=(x,status=200)=>new Response(JSON.stringify(x),{status})
test('lists only server session metadata and rejects malformed or duplicate identities',async()=>{
 let rows=[session];const client=createLocalSessionsClient(async()=>json({sessions:rows}));assert.deepEqual(await client.list(),rows);rows=[session,session];await assert.rejects(client.list(),/无法确认/)
})
test('revoke uses fresh CSRF even after another account operation, exact 204 and no bearer',async()=>{
 const calls=[];const client=createLocalSessionsClient(async(path,options)=>{calls.push({path,...options});return path.endsWith('/csrf')?json({csrfToken:'c'.repeat(43)}):new Response(null,{status:204})})
 await client.revoke(id);await client.revoke(id);assert.equal(calls.length,4);assert.equal(calls[1].method,'DELETE');assert.equal(calls[1].headers['X-CSRF-Token'],'c'.repeat(43));assert.equal(calls[1].headers.Authorization,undefined);assert.equal(calls[1].credentials,'same-origin')
})
test('unknown revoke blocks resend across callers until a successful read reconciles',async()=>{
 let writes=0;const client=createLocalSessionsClient(async(path)=>{if(path.endsWith('/csrf'))return json({csrfToken:'c'.repeat(43)});if(path.endsWith('/sessions'))return json({sessions:[]});writes++;return json({})})
 await assert.rejects(client.revoke(id),/无法确认/);await assert.rejects(client.revoke(id),/刷新/);assert.equal(writes,1);await client.list();await assert.rejects(client.revoke(id),/无法确认/);assert.equal(writes,2)
})
test('revoke others posts bodyless with fresh CSRF, validates 204 and never rotates current token',async()=>{
 const calls=[];const client=createLocalSessionsClient(async(path,options)=>{calls.push({path,...options});return path.endsWith('/csrf')?json({csrfToken:'c'.repeat(43)}):new Response(null,{status:204})})
 await client.revokeOthers();assert.equal(calls[1].path,'/api/v1/auth/sessions/revoke-others');assert.equal(calls[1].method,'POST');assert.equal(calls[1].body,undefined);assert.equal(calls[1].headers['X-CSRF-Token'],'c'.repeat(43))
})
test('list cannot unlock an in-flight revoke, and a malformed read cannot unlock unknown',async()=>{
 let finish;let writes=0;let malformed=false
 const client=createLocalSessionsClient(async path=>{if(path.endsWith('/csrf'))return json({csrfToken:'c'.repeat(43)});if(path.endsWith('/sessions'))return json(malformed?{}:{sessions:[session]});writes++;return new Promise(r=>{finish=r})})
 const pending=client.revoke(id);await new Promise(r=>setImmediate(r));await client.list();await assert.rejects(client.revoke(id),/进行中/);assert.equal(writes,1)
 finish(json({}));await assert.rejects(pending,/无法确认/);malformed=true;await assert.rejects(client.list(),/无法确认/);await assert.rejects(client.revoke(id),/刷新/);assert.equal(writes,1)
})
