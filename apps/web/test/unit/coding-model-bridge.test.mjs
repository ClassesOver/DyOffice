import test from 'node:test'
import assert from 'node:assert/strict'
import {createCodingModelBridge} from '../../server/src/modules/coding/model-bridge.ts'

const task={instructions:'Code carefully',input:[{role:'user',content:[{type:'input_text',text:'write a parser'}]}],tools:[{type:'function',name:'exec_command',description:'Run shell',parameters:{type:'object',properties:{cmd:{type:'string'}}}}],stream:true,model:'untrusted-model'}
test('Codex requests use Office model and session through the budgeted gateway, not supplied model or keys',async()=>{
 const calls=[]
 const bridge=await createCodingModelBridge({token:'office-session',modelId:'office-selected',signal:new AbortController().signal,turns:{async run(input,emit){calls.push(input);await emit({type:'tool_call',id:'call1',name:'exec_command',input:{cmd:'echo ok'}});await emit({type:'usage',inputTokens:4,outputTokens:3})}}})
 try {
  const rejected=await fetch(bridge.baseUrl+'/responses',{method:'POST',body:JSON.stringify(task),headers:{authorization:'Bearer wrong'}})
  assert.equal(rejected.status,401);assert.equal(calls.length,0)
  const response=await fetch(bridge.baseUrl+'/responses',{method:'POST',body:JSON.stringify(task),headers:{authorization:'Bearer '+bridge.apiKey}})
  const text=await response.text()
  assert.equal(response.status,200);assert.equal(calls.length,1)
  assert.equal(calls[0].token,'office-session');assert.equal(calls[0].modelId,'office-selected')
  assert.equal(calls[0].request.messages[0].text,'write a parser')
  assert.match(text,/response.output_item.done/);assert.match(text,/response.completed/);assert.match(text,/exec_command/)
  assert.doesNotMatch(text,/office-session/)
 }finally{await bridge.close()}
})
test('quota rejection returns a failed response, never completion or retry',async()=>{
 let calls=0
 const bridge=await createCodingModelBridge({token:'session',modelId:'selected',signal:new AbortController().signal,turns:{async run(){calls++;throw Error('private quota detail')}}})
 try {
  const response=await fetch(bridge.baseUrl+'/responses',{method:'POST',body:JSON.stringify(task),headers:{authorization:'Bearer '+bridge.apiKey}})
  const text=await response.text();assert.equal(calls,1)
  assert.match(text,/response.failed/);assert.doesNotMatch(text,/response.completed|private quota/)
 }finally{await bridge.close()}
})
test('custom apply_patch calls and batched results survive the Responses/chat conversion',async()=>{
 const seen=[]
 const bridge=await createCodingModelBridge({token:'session',modelId:'selected',signal:new AbortController().signal,turns:{async run(input,emit){seen.push(input);await emit({type:'delta',text:'Tested'})}}})
 try {
  const request={...task,tools:[{type:'custom',name:'apply_patch',description:'Patch'}],input:[...task.input,{type:'custom_tool_call',call_id:'patch1',name:'apply_patch',input:'*** Begin Patch'},{type:'custom_tool_call_output',call_id:'patch1',output:'ok'}]}
  const response=await fetch(bridge.baseUrl+'/responses',{method:'POST',body:JSON.stringify(request),headers:{authorization:'Bearer '+bridge.apiKey}})
  assert.match(await response.text(),/Tested/)
  assert.deepEqual(seen[0].request.messages[1].toolCalls,[{id:'patch1',name:'apply_patch',input:{input:'*** Begin Patch'}}])
  assert.equal(seen[0].request.messages[2].results[0].name,'apply_patch')
 }finally{await bridge.close()}
})

test('each coding round keeps the selected Office model and receives a fresh turn identity',async()=>{
 const seen=[]
 const bridge=await createCodingModelBridge({token:'session',modelId:'selected',signal:new AbortController().signal,turns:{async run(input,emit){seen.push(input);await emit({type:'delta',text:'round '+seen.length})}}})
 try {
  for(let round=0;round<2;round++) {
   const response=await fetch(bridge.baseUrl+'/responses',{method:'POST',body:JSON.stringify(task),headers:{authorization:'Bearer '+bridge.apiKey}})
   assert.match(await response.text(),/response.completed/)
  }
  assert.equal(seen.length,2);assert.notEqual(seen[0].turnId,seen[1].turnId)
  assert.deepEqual(seen.map(x=>x.modelId),['selected','selected'])
 }finally{await bridge.close()}
})

test('unsupported tools cannot enter the gateway or be replayed as historical calls',async()=>{
 const seen=[]
 const bridge=await createCodingModelBridge({token:'session',modelId:'selected',signal:new AbortController().signal,turns:{async run(input,emit){seen.push(input);await emit({type:'delta',text:'ok'})}}})
 try {
  const tools=[...task.tools,{type:'function',name:'read_knowledge_file',parameters:{type:'object'}}]
  const send=body=>fetch(bridge.baseUrl+'/responses',{method:'POST',body:JSON.stringify(body),headers:{authorization:'Bearer '+bridge.apiKey}})
  assert.match(await (await send({...task,tools})).text(),/response.completed/)
  assert.deepEqual(seen[0].request.tools.map(x=>x.name),['exec_command'])
  const rejected=await send({...task,tools,input:[...task.input,{type:'function_call',call_id:'foreign',name:'read_knowledge_file',arguments:'{}'}]})
  assert.equal(rejected.status,400);assert.match(await rejected.text(),/response.failed/);assert.equal(seen.length,1)
 }finally{await bridge.close()}
})

test('oversized requests and previous-response continuation fail before gateway dispatch',async()=>{
 let calls=0
 const bridge=await createCodingModelBridge({token:'session',modelId:'selected',signal:new AbortController().signal,turns:{async run(){calls++}}})
 try {
  for(const body of [{...task,previous_response_id:'unbound-response'},{...task,input:'x'.repeat(1024*1024)}]) {
   const response=await fetch(bridge.baseUrl+'/responses',{method:'POST',body:JSON.stringify(body),headers:{authorization:'Bearer '+bridge.apiKey}})
   assert.equal(response.status,400);assert.match(await response.text(),/response.failed/)
  }
  assert.equal(calls,0)
 }finally{await bridge.close()}
})

test('task cancellation aborts the active model round and closes its HTTP response',async()=>{
 const controller=new AbortController();let started,aborted=false
 const ready=new Promise(resolve=>{started=resolve})
 const bridge=await createCodingModelBridge({token:'session',modelId:'selected',signal:controller.signal,turns:{async run(input){started();await new Promise((_,reject)=>input.signal.addEventListener('abort',()=>{aborted=true;reject(Error('cancelled'))},{once:true}))}}})
 try {
  const work=fetch(bridge.baseUrl+'/responses',{method:'POST',body:JSON.stringify(task),headers:{authorization:'Bearer '+bridge.apiKey}}).then(response=>response.text())
  const terminal=assert.rejects(work)
  await ready;controller.abort();await terminal
  assert.equal(aborted,true)
 }finally{await bridge.close()}
})

test('live assistant text is reported before model settlement without exposing tool arguments or reasoning',async()=>{
 let release,started
 const gate=new Promise(resolve=>{release=resolve}),ready=new Promise(resolve=>{started=resolve}),progress=[]
 const bridge=await createCodingModelBridge({token:'session',modelId:'selected',signal:new AbortController().signal,onProgress:event=>progress.push(event),turns:{async run(input,emit){
  await emit({type:'reasoning',text:'private reasoning'})
  await emit({type:'delta',text:'Checking '});await emit({type:'delta',text:'the calculation'})
  await emit({type:'tool_call',id:'call1',name:'exec_command',input:{cmd:'private command'}})
  started();await gate
 }}})
 const pending=fetch(bridge.baseUrl+'/responses',{method:'POST',body:JSON.stringify(task),headers:{authorization:'Bearer '+bridge.apiKey}}).then(response=>response.text())
 try{
  await ready
  assert.equal(progress.filter(event=>event.kind==='output').map(event=>event.text).join(''),'Checking the calculation')
  assert.doesNotMatch(JSON.stringify(progress),/private command|private reasoning/)
 }finally{release();await pending;await bridge.close()}
})
