import test from 'node:test'
import assert from 'node:assert/strict'
import {createBackgroundAnswer} from '../../server/src/modules/assistant-channel/background-answer.ts'
const input={token:'owner-session',instruction:'Find budget',text:'Budget: 42万元',revision:'saved-version',format:'docx',truncated:false,tools:[],signal:new AbortController().signal}
for(const format of ['docx','xlsx','pptx','pdf'])test('background answer uses actual '+format+' format and extraction limitations',async()=>{
 const answer=createBackgroundAnswer({defaultModel:async()=> 'model',run:async(request,emit)=>{
  assert.equal(request.request.format,format)
  assert.equal(JSON.parse(request.request.messages[0].text).format,format)
  assert.match(request.request.system,/cached.*values|缓存/)
  emit({type:'delta',text:'42'})
 }})
 assert.equal(await answer({...input,format}),'42')
})
test('background answer uses owner model gateway and a bounded read-only document request',async()=>{
 const answer=createBackgroundAnswer({defaultModel:async token=>{assert.equal(token,input.token);return 'owner-model'},run:async(request,emit)=>{
  assert.equal(request.token,input.token);assert.equal(request.modelId,'owner-model');assert.equal(request.signal,input.signal)
  assert.deepEqual(request.request.tools,[])
  const message=JSON.parse(request.request.messages[0].text)
  assert.equal(message.documentText,input.text);assert.equal(message.savedRevision,input.revision)
  emit({type:'delta',text:'预算为'});emit({type:'delta',text:'42万元'})
 }})
 assert.equal(await answer(input),'预算为42万元')
})
for(const failure of ['tool','oversize','empty','missing-model'])test('background answer rejects '+failure,async()=>{
 let calls=0
 const answer=createBackgroundAnswer({defaultModel:async()=>failure==='missing-model'?undefined:'model',run:async(_request,emit)=>{
  calls++
  if(failure==='tool')emit({type:'tool_call',name:'write_file',input:{}})
  if(failure==='oversize')emit({type:'delta',text:'中'.repeat(6000)})
 }})
 await assert.rejects(answer(input))
 assert.equal(calls,failure==='missing-model'?0:1)
})
test('truncated document always carries an explicit excerpt notice in the persisted answer',async()=>{
 const answer=createBackgroundAnswer({defaultModel:async()=> 'model',run:async(_request,emit)=>{emit({type:'delta',text:'预算为42万元'})}})
 assert.match(await answer({...input,truncated:true}),/文字已截断.*24,000/)
})
test('a model length limit cannot turn partial text into a successful background result',async()=>{
 let settled=false
 const answer=createBackgroundAnswer({defaultModel:async()=> 'model',run:async(_request,emit)=>{
  emit({type:'delta',text:'预算为'})
  emit({type:'stop_reason',reason:'max_tokens'})
  settled=true
 }})
 await assert.rejects(answer(input),/output length limit/i)
 assert.equal(settled,true)
})
