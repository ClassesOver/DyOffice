import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createLoginHistoryClient} from '../src/shell/local-login-history-client.ts'
test('history page follows bounded server cursor instead of truncating loaded history',async()=>{
 const cursor='00000000-0000-4000-8000-000000000001';let called
 const client=createLoginHistoryClient(async url=>{called=url;return new Response(JSON.stringify({events:Array.from({length:5},()=>({occurredAt:'2026-01-01T00:00:00.000Z',outcome:'success'})),nextCursor:cursor}))})
 const result=await client.listPage({limit:5,after:cursor});assert.equal(result.nextCursor,cursor);assert.equal(called,`/api/v1/auth/login-history?limit=5&after=${cursor}`)
})
test('page rejects malformed cursors, truncated page metadata and excessive results',async()=>{
 const cursor='00000000-0000-4000-8000-000000000001'
 for(const body of [{events:[],nextCursor:cursor},{events:[],nextCursor:'bad'},{events:[]},{events:Array(6).fill({occurredAt:'2026-01-01',outcome:'success'}),nextCursor:null}])await assert.rejects(createLoginHistoryClient(async()=>new Response(JSON.stringify(body))).listPage({limit:5}))
 let sent=false;await assert.rejects(createLoginHistoryClient(async()=>{sent=true}).listPage({limit:21}));assert.equal(sent,false)
})
