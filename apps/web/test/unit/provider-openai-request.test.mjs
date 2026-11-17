import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
const m=await import('../../server/src/modules/providers/openai-request.ts').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e})
const profile={model:'gpt-test',maxOutputTokens:1024}
const tool={name:'read_doc',description:'Read document',inputSchema:{type:'object',properties:{b:{type:'number'},a:{type:'string'}}}}
const base=()=>({system:'Be helpful',messages:[{role:'user',text:'你好'}],tools:[]})
const build=(request=base(),p=profile)=>{assert.equal(typeof m.buildOpenAiChatRequest,'function');return m.buildOpenAiChatRequest(request,p)}
test('builds exact compact UTF8 bytes and their only SHA256 from trusted model and limit',()=>{
 const r=build();const payload=JSON.parse(r.body.toString('utf8'))
 assert.deepEqual(payload,{model:'gpt-test',max_tokens:1024,stream:true,stream_options:{include_usage:true},messages:[{role:'system',content:'Be helpful'},{role:'user',content:'你好'}]})
 assert.equal(r.digest,createHash('sha256').update(r.body).digest('hex'));assert.ok(Object.isFrozen(r));assert.equal(r.body.toString(),JSON.stringify(payload))
})
test('canonical nested JSON key ordering yields identical wire bytes and digest',()=>{
 const a={...base(),tools:[tool]},b={...base(),tools:[{...tool,inputSchema:{properties:{a:{type:'string'},b:{type:'number'}},type:'object'}}]}
 assert.equal(build(a).digest,build(b).digest)
})
test('projects matched complete tool history and preserves error results explicitly',()=>{
 const request={system:'',tools:[tool],messages:[{role:'user',text:'read'},{role:'assistant',text:'',toolCalls:[{id:'call_1',name:'read_doc',input:{b:2,a:'v'}}]},{role:'tool',results:[{id:'call_1',name:'read_doc',output:'not found',isError:true}]}]}
 const p=JSON.parse(build(request).body)
 assert.deepEqual(p.messages[2],{role:'assistant',content:'',tool_calls:[{id:'call_1',type:'function',function:{name:'read_doc',arguments:'{"a":"v","b":2}'}}]})
 assert.deepEqual(p.messages[3],{role:'tool',tool_call_id:'call_1',content:'{"output":"not found","isError":true}'})
 assert.deepEqual(p.tools[0],{type:'function',function:{name:'read_doc',description:'Read document',parameters:{properties:{a:{type:'string'},b:{type:'number'}},type:'object'}}})
})
test('personal final reply accepts paired approved history without offering new tools',()=>{
 const request={system:'',tools:[],messages:[{role:'assistant',text:'',toolCalls:[{id:'c',name:'read_doc',input:{}}]},{role:'tool',results:[{id:'c',name:'read_doc',output:'ok'}]}]}
 assert.throws(()=>build(request))
 const wire=JSON.parse(m.buildOpenAiChatRequest(request,profile,new Set(['read_doc'])).body)
 assert.equal(wire.tools,undefined)
 assert.equal(wire.messages[2].tool_call_id,'c')
})
test('unsupported modalities/vendor metadata and routing/secret overrides fail closed',()=>{
 for(const change of [r=>r.model='evil',r=>r.baseURL='https://evil',r=>r.apiKey='secret',r=>r.headers={},r=>r.messages[0].images=[],r=>r.messages[0].role='system',r=>r.messages=[{role:'assistant',text:'ok',reasoning:''}],r=>r.tools=[{...tool,provider:'other'}]]){
  const r=base();change(r);assert.throws(()=>build(r),{message:'Invalid provider request'})
 }
 for(const key of ['signature','inputError','truncated']){
  const call={id:'c',name:'read_doc',input:{},[key]:undefined}
  assert.throws(()=>build({system:'',tools:[tool],messages:[{role:'assistant',text:'',toolCalls:[call]}]}),{message:'Invalid provider request'})
 }
})
test('tool results must match the complete immediately pending batch by id and name',()=>{
 const request=()=>({system:'',tools:[tool],messages:[{role:'assistant',text:'',toolCalls:[{id:'c',name:'read_doc',input:{}}]},{role:'tool',results:[{id:'c',name:'read_doc',output:'ok'}]}]})
 for(const change of [r=>r.messages.pop(),r=>r.messages[1].results[0].id='other',r=>r.messages[1].results[0].name='other',r=>r.messages[1].results.push({...r.messages[1].results[0]}),r=>r.messages.splice(1,0,{role:'user',text:'interrupt'}),r=>r.messages.shift(),r=>r.messages[0].toolCalls[0].name='undeclared',r=>r.tools.push({...tool})]){
  const r=request();change(r);assert.throws(()=>build(r),{message:'Invalid provider request'})
 }
})
test('tool IDs cannot be reused across history even after a completed batch',()=>{
 const call={role:'assistant',text:'',toolCalls:[{id:'c',name:'read_doc',input:{}}]},result={role:'tool',results:[{id:'c',name:'read_doc',output:'ok'}]}
 assert.throws(()=>build({system:'',tools:[tool],messages:[call,result,call,result]}),{message:'Invalid provider request'})
})
test('invalid JSON values/keys/accessors/cycles and malformed Unicode are never normalized silently',()=>{
 const cycle={};cycle.self=cycle
 for(const input of [{x:undefined},{x:NaN},{x:Infinity},{x:BigInt(1)},new Date(),cycle,JSON.parse('{"__proto__":{}}'),{constructor:'bad'},Object.defineProperty({},'x',{enumerable:true,get(){throw Error('private secret')}})]){
  assert.throws(()=>build({...base(),tools:[{...tool,inputSchema:input}]}),{message:'Invalid provider request'})
 }
 assert.throws(()=>build({...base(),system:'\ud800'}),{message:'Invalid provider request'})
})
test('strict model/output-token settings and byte/count budgets fail closed',()=>{
 for(const p of [{...profile,maxOutputTokens:0},{...profile,maxOutputTokens:Infinity},{...profile,maxOutputTokens:32769},{...profile,model:'model\nsecret'},{...profile,headers:{}}])assert.throws(()=>build(base(),p),{message:'Invalid provider request'})
 assert.throws(()=>build({...base(),system:'x'.repeat(256*1024+1)}),{message:'Invalid provider request'})
 assert.throws(()=>build({...base(),messages:Array.from({length:513},()=>({role:'user',text:'a'}))}),{message:'Invalid provider request'})
 assert.throws(()=>build({...base(),messages:Array.from({length:5},()=>({role:'user',text:'x'.repeat(256*1024)}))}),{message:'Invalid provider request'})
})
test('built body is detached from caller mutation; metadata is frozen, Buffer remains explicitly mutable',()=>{
 const r=base();const p=build(r);const before=p.body.toString();r.messages[0].text='changed';assert.equal(p.body.toString(),before)
 p.body[0]=32;assert.notEqual(createHash('sha256').update(p.body).digest('hex'),p.digest)
})

test('UTF8 size, final escaping expansion and recursive structure limits are enforced',()=>{
 assert.throws(()=>build({...base(),system:'好'.repeat(87382)}),{message:'Invalid provider request'})
 assert.throws(()=>build({...base(),messages:[{role:'user',text:'\u0000'.repeat(200000)}]}),{message:'Invalid provider request'})
 let deep={};for(let i=0;i<26;i++)deep={child:deep}
 assert.throws(()=>build({...base(),tools:[{...tool,inputSchema:deep}]}),{message:'Invalid provider request'})
 const sparse=[];sparse.length=1
 assert.throws(()=>build({...base(),tools:[{...tool,inputSchema:{items:sparse}}]}),{message:'Invalid provider request'})
 const symbols={[Symbol('private')]:1}
 assert.throws(()=>build({...base(),tools:[{...tool,inputSchema:symbols}]}),{message:'Invalid provider request'})
})
test('absent versus explicit false error flags retain distinct tool-result content',()=>{
 const r=flag=>({system:'',tools:[tool],messages:[{role:'assistant',text:'',toolCalls:[{id:'c',name:'read_doc',input:{}}]},{role:'tool',results:[{id:'c',name:'read_doc',output:'ok',...flag}]}]})
 assert.equal(JSON.parse(build(r({})).body).messages[2].content,'{"output":"ok"}')
 assert.equal(JSON.parse(build(r({isError:false})).body).messages[2].content,'{"output":"ok","isError":false}')
 assert.throws(()=>build(r({isError:'false'})),{message:'Invalid provider request'})
})
