import test from 'node:test'
import assert from 'node:assert/strict'
import {createLoginHistoryClient} from '../src/shell/local-login-history-client.ts'
const json=(body,status=200)=>new Response(JSON.stringify(body),{status})
test('history requests only own cookie-scoped fixed endpoint and projects allowed fields',async()=>{
 const calls=[];const client=createLoginHistoryClient(async(path,init)=>{calls.push({path,...init});return json({events:[{occurredAt:'2026-11-16T00:00:00.000Z',outcome:'success',accountKey:'must not surface',sessionId:'must not surface'}]})})
 assert.deepEqual(await client.list(),[{occurredAt:'2026-11-16T00:00:00.000Z',outcome:'success'}]);assert.equal(calls[0].path,'/api/v1/auth/login-history');assert.equal(calls[0].credentials,'same-origin');assert.equal(calls[0].cache,'no-store');assert.equal(calls[0].redirect,'error');assert.equal(calls[0].headers,undefined)
})
test('malformed, over-limit and unauthorized responses never become an empty success',async()=>{
 for(const body of [{}, {events:[{occurredAt:'bad',outcome:'success'}]}, {events:[{occurredAt:'2026-11-16',outcome:'admin-reset'}]}, {events:Array.from({length:21},()=>({occurredAt:'2026-11-16',outcome:'failure'}))}])await assert.rejects(createLoginHistoryClient(async()=>json(body)).list(),/无法确认/)
 await assert.rejects(createLoginHistoryClient(async()=>json({error:'private detail'},401)).list(),/登录/)
})
