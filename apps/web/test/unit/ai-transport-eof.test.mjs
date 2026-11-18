import test from 'node:test'
import assert from 'node:assert/strict'
import {createSseAgentTransport} from '../../../../packages/browser-host/src/ai-transport.ts'
test('application done cancels a still-open response body before HTTP EOF',async()=>{
 let cancelled,finish
 const cancellation=new Promise(resolve=>cancelled=resolve),completion=new Promise(resolve=>finish=resolve),calls=[]
 const body=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('event: delta\ndata: {"text":"synthetic"}\n\nevent: done\ndata: {}\n\n'))},cancel(){calls.push('reader-cancel');cancelled()}})
 const transport=createSseAgentTransport({fetchImpl:async()=>new Response(body,{headers:{'content-type':'text/event-stream'}})})
 transport.stream({system:'',messages:[],tools:[]},{onDelta:()=>calls.push('delta'),onToolCall(){},onError:()=>calls.push('error'),onDone(){calls.push('done');finish()}})
 await completion;await cancellation
 assert.deepEqual(calls,['delta','done','reader-cancel'])
 // No close() was issued. This is the real adapter over a controlled body,
 // not evidence of Chromium's requestfailed classification or durable settlement.
})
