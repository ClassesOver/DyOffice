import test from 'node:test'
import assert from 'node:assert/strict'
import {createPdfMediaSkill} from '../../src/editors/pdf-media-skill.ts'
const call=(name,input)=>({id:'call',name,input})
const generated='https://generated-image.invalid/opaque-id'
const image={title:'Photo',imageUrl:'https://example.com/photo.png',width:640,height:480}

test('only configured PDF media dependencies offer tools',()=>{
 assert.deepEqual(createPdfMediaSkill({}).tools,[])
 assert.deepEqual(createPdfMediaSkill({imageSearch:async()=>({images:[]})}).tools.map(t=>t.name),['image_search'])
 assert.deepEqual(createPdfMediaSkill({generateImage:async()=>({url:generated})}).tools.map(t=>t.name),['generate_image'])
 const skill=createPdfMediaSkill({imageSearch:async()=>({images:[]}),generateImage:async()=>({url:generated})})
 assert.deepEqual(skill.tools.map(t=>t.name),['image_search','generate_image'])
 for(const tool of skill.tools)assert.equal(tool.inputSchema.additionalProperties,false)
})

test('search forwards PC parameter names and returns numbered direct image URLs without changing PDF',async()=>{
 const calls=[],signal=new AbortController().signal,skill=createPdfMediaSkill({imageSearch:async(...args)=>{calls.push(args);return {images:[image,{imageUrl:'https://example.com/second.jpg'}],method:'provider'}}})
 const result=await skill.executeTool(call('image_search',{query:'  office photos  ',max_results:2}),signal)
 assert.deepEqual(calls,[['office photos',2,signal]])
 assert.match(result.output,/1\. Photo.*640.*480/);assert.match(result.output,/https:\/\/example.com\/photo.png/)
 assert.match(result.output,/2\./);assert.equal(result.mutated,false);assert.equal(result.isError,undefined)
 await skill.executeTool(call('image_search',{query:'flowers'}));assert.equal(calls[1][1],8)
})

test('empty search is distinct from provider failure and invalid result URLs',async()=>{
 const empty=await createPdfMediaSkill({imageSearch:async()=>({images:[]})}).executeTool(call('image_search',{query:'flowers'}))
 assert.match(empty.output,/no images found/i);assert.equal(empty.isError,undefined)
 for(const reply of [{images:[],method:'error',error:'upstream failed'},{images:[],error:'failed'},{images:[{imageUrl:'data:image/png;base64,SECRET'}]},{images:[{imageUrl:'javascript:alert(1)'}]},{images:null}]){
  const result=await createPdfMediaSkill({imageSearch:async()=>reply}).executeTool(call('image_search',{query:'flowers'}))
  assert.equal(result.isError,true);assert.equal(result.mutated,false);assert.doesNotMatch(result.output,/SECRET|javascript:|saved/i)
 }
})

test('generation forwards aspect_ratio and only exposes an opaque HTTP URL for later insertion',async()=>{
 const calls=[],signal=new AbortController().signal,skill=createPdfMediaSkill({generateImage:async(...args)=>{calls.push(args);return {url:generated}}})
 const result=await skill.executeTool(call('generate_image',{prompt:'  A blue diagram  ',aspect_ratio:'16:9'}),signal)
 assert.deepEqual(calls,[[{prompt:'A blue diagram',aspectRatio:'16:9'},signal]])
 assert.match(result.output,/https:\/\/generated-image.invalid\/opaque-id/);assert.match(result.output,/insert_image/)
 assert.equal(result.mutated,false);assert.equal(result.isError,undefined);assert.doesNotMatch(result.output,/saved|base64|data:/i)
 await skill.executeTool(call('generate_image',{prompt:'Icon'}));assert.deepEqual(calls[1][0],{prompt:'Icon'})
})

test('invalid parameters never reach dependencies or expose unconfigured tools',async()=>{
 let calls=0;const skill=createPdfMediaSkill({imageSearch:async()=>{calls++;return {images:[]}},generateImage:async()=>{calls++;return {url:generated}}})
 const searches=[{},null,[],{query:''},{query:' '},{query:3},{query:'x'.repeat(301)},{query:'x',max_results:0},{query:'x',max_results:9},{query:'x',max_results:1.5},{query:'x',max_results:'2'},{query:'x',maxResults:2},{query:'x',unknown:true}]
 const generations=[{},null,[],{prompt:''},{prompt:' '},{prompt:1},{prompt:'x'.repeat(4001)},{prompt:'x',aspect_ratio:'invalid'},{prompt:'x',aspect_ratio:16},{prompt:'x',aspectRatio:'1:1'},{prompt:'x',url:'https://example.com'}]
 searches.push(Object.assign(Object.create({inherited:true}),{query:'x'}),Object.defineProperty({query:'x'},'max_results',{get(){throw Error('getter must not run')},enumerable:true}),{query:'x',[Symbol('hidden')]:true})
 generations.push(Object.defineProperty({},'prompt',{get(){throw Error('getter must not run')},enumerable:true}))
 for(const [name,values]of [['image_search',searches],['generate_image',generations]])for(const input of values){const result=await skill.executeTool(call(name,input));assert.equal(result.isError,true);assert.equal(result.mutated,false)}
 for(const name of ['image_search','generate_image','unknown'])assert.equal((await createPdfMediaSkill({}).executeTool(call(name,{query:'x',prompt:'x'}))).isError,true)
 assert.equal(calls,0)
})

test('upstream errors missing results and non-HTTP generation URLs never report success or echo bytes',async()=>{
 for(const reply of [{},{url:''},{url:'data:image/png;base64,SECRET'},{url:'file:///tmp/private.png'},{url:'javascript:alert(1)'},{url:'https://user:secret@example.com/image'},{url:generated,error:'failure'}]){
  const result=await createPdfMediaSkill({generateImage:async()=>reply}).executeTool(call('generate_image',{prompt:'Icon'}))
  assert.equal(result.isError,true);assert.equal(result.mutated,false);assert.doesNotMatch(result.output,/SECRET|base64|data:|file:|secret|saved/i)
 }
 for(const name of ['image_search','generate_image']){
  const result=await createPdfMediaSkill({imageSearch:async()=>{throw Error('data:image/png;base64,SECRET')},generateImage:async()=>{throw Error('data:image/png;base64,SECRET')}}).executeTool(call(name,name==='image_search'?{query:'x'}:{prompt:'x'}))
  assert.equal(result.isError,true);assert.doesNotMatch(result.output,/SECRET|base64|data:|saved/i)
 }
})

for(const name of ['image_search','generate_image'])test(name+' cancellation before and after dependency await discards results',async()=>{
 const input=name==='image_search'?{query:'x'}:{prompt:'x'},controller=new AbortController();let calls=0,resolve
 const dep=async()=>{calls++;return new Promise(r=>{resolve=r})},skill=createPdfMediaSkill({imageSearch:dep,generateImage:dep})
 const pending=skill.executeTool(call(name,input),controller.signal);await new Promise(r=>setImmediate(r));controller.abort();resolve(name==='image_search'?{images:[image]}:{url:generated})
 await assert.rejects(pending,{name:'AbortError'});assert.equal(calls,1)
 await assert.rejects(skill.executeTool(call(name,input),controller.signal),{name:'AbortError'});assert.equal(calls,1)
})
