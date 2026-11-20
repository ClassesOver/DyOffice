import test from 'node:test'
import assert from 'node:assert/strict'
import {createPdfCreateDocumentSkill,createPdfDocumentCreator} from '../../src/shell/pdf-create-document-skill.ts'
const receipt={fileId:'created-file',revision:'saved-revision',sha256:'a'.repeat(64),size:120}
const input={type:'pdf',title:'Budget report',content:'<p>42 CNY</p>'}
const call=(input)=>({id:'call',name:'create_document',input})

test('PDF creation offers PDF and capability-gated DOCX only and confirms the saved receipt',async()=>{
 for(const docxEditable of [false,true]){
  const requests=[],skill=createPdfCreateDocumentSkill({docxEditable,createDocument:async value=>{requests.push(value);return receipt}})
  assert.deepEqual(skill.tools[0].inputSchema.properties.type.enum,docxEditable?['pdf','docx']:['pdf'])
  const result=await skill.executeTool(call({title:input.title,content:input.content}))
  assert.equal(result.isError,undefined);assert.equal(result.mutated,true)
  assert.match(result.output,/created-file/);assert.match(result.output,/saved-revision/)
  assert.deepEqual(requests,[input])
 }
})
test('unsupported types, invalid content and unconfirmed receipts never claim creation',async()=>{
 let calls=0
 const skill=createPdfCreateDocumentSkill({docxEditable:false,createDocument:async()=>{calls++;return {fileId:'opened-tab'}}})
 for(const value of [{...input,type:'md'},{...input,type:'html'},{...input,type:'docx'},{...input,title:''},{...input,content:' '}])assert.equal((await skill.executeTool(call(value))).isError,true)
 assert.equal(calls,0)
 const result=await skill.executeTool(call(input));assert.equal(result.isError,true);assert.equal(result.mutated,false);assert.match(result.output,/not confirmed|未确认/)
})
for(const type of ['pdf','docx'])for(const [kind,content] of [
 ['tool-response markup','<tool_response>Tool output</tool_response>'],
 ['raw block JSON','{"index":1,"type":"paragraph"}'],
])test(`PDF assistant rejects ${kind} before creating a ${type.toUpperCase()} document`,async()=>{
 const requests=[],skill=createPdfCreateDocumentSkill({docxEditable:true,createDocument:async value=>{requests.push(value);return receipt}})
 const result=await skill.executeTool(call({...input,type,content}))
 assert.equal(result.isError,true)
 assert.equal(result.mutated,false)
 assert.deepEqual(requests,[])
 const corrected={...input,type}
 assert.equal((await skill.executeTool(call(corrected))).mutated,true)
 assert.deepEqual(requests,[corrected])
})
test('creator binds the workspace before any async generation and saves with that captured identity',async()=>{
 let account='alice';const events=[]
 const creator=createPdfDocumentCreator({prepare:async()=>{
  const captured=account;events.push('bind:'+captured)
  return {docxEditable:true,save:async value=>{events.push('save:'+captured);assert.equal(value.file.type,'application/pdf');return receipt}}
 },loadFont:async()=>{events.push('font');account='bob';return new Uint8Array([1])},renderPdf:async()=>{events.push('render');return new Uint8Array([37,80,68,70,45])}})
 assert.deepEqual(await creator(input),receipt)
 assert.deepEqual(events,['bind:alice','font','render','save:alice'])
})
test('DOCX creation rechecks captured capability and waits for its real serialized revision',async()=>{
 let finish;const creator=createPdfDocumentCreator({prepare:async()=>({docxEditable:true,save:async value=>{assert.equal(value.type,'docx');assert.equal(value.file,undefined);return new Promise(resolve=>{finish=resolve})}}),loadFont:async()=>assert.fail('DOCX must not generate PDF')})
 let settled=false;const promise=creator({...input,type:'docx'}).then(value=>{settled=true;return value})
 await new Promise(resolve=>setImmediate(resolve));assert.equal(settled,false);finish(receipt);assert.deepEqual(await promise,receipt)
 const disabled=createPdfDocumentCreator({prepare:async()=>({docxEditable:false,save:async()=>assert.fail('disabled DOCX')}),loadFont:async()=>assert.fail('font')})
 await assert.rejects(disabled({...input,type:'docx'}),/DOCX/)
})
test('unknown save outcome blocks repeated generation and malformed receipts cannot acknowledge a file',async()=>{
 for(const malformed of [false,true]){
  let renders=0,saves=0
  const creator=createPdfDocumentCreator({prepare:async()=>({docxEditable:false,save:async()=>{saves++;if(malformed)return {fileId:'tab'};throw Error('connection lost')}}),loadFont:async()=>new Uint8Array([1]),renderPdf:async()=>{renders++;return new Uint8Array([1])}})
  await assert.rejects(creator(input))
  await assert.rejects(creator(input),/confirm|确认/)
  assert.equal(renders,1);assert.equal(saves,1)
 }
})
test('cancellation after generation prevents saving; concurrency cannot create a second file',async()=>{
 let rendered;const controller=new AbortController(),creator=createPdfDocumentCreator({prepare:async()=>({docxEditable:false,save:async()=>assert.fail('cancelled save')}),loadFont:async()=>new Uint8Array([1]),renderPdf:async()=>new Promise(resolve=>{rendered=resolve})})
 const first=creator(input,controller.signal);await new Promise(resolve=>setImmediate(resolve))
 await assert.rejects(creator(input),/progress|进行/)
 controller.abort();rendered(new Uint8Array([1]));await assert.rejects(first)
})
for(const status of [401,403,409])test('late save HTTP '+status+' remains unconfirmed and never generates a replacement',async()=>{
 let saves=0,renders=0
 const creator=createPdfDocumentCreator({prepare:async()=>({docxEditable:false,save:async()=>{saves++;throw Object.assign(Error('late rejection'),{status})}}),loadFont:async()=>new Uint8Array([1]),renderPdf:async()=>{renders++;return new Uint8Array([1])}})
 const skill=createPdfCreateDocumentSkill({docxEditable:false,createDocument:creator})
 const first=await skill.executeTool(call(input));assert.equal(first.isError,true);assert.equal(first.mutated,false)
 assert.match(first.output,/Check existing workspace files/)
 assert.equal((await skill.executeTool(call(input))).isError,true)
 assert.equal(saves,1);assert.equal(renders,1)
})
test('session rotation during PDF rendering cannot send a write as the newly logged-in account',async()=>{
 const {createLocalShellClient}=await import('../../src/shell/local-client.ts')
 const oldProof='a'.repeat(43),newProof='b'.repeat(43);let currentProof=oldProof,writes=0
 const client=createLocalShellClient(async(path,init={})=>{
  if(path==='/api/v1/auth/session-proof')return Response.json({csrfToken:currentProof})
  if(init.headers['X-CSRF-Token']!==currentProof)return Response.json({error:'stale proof'},{status:403})
  writes++;return Response.json(receipt)
 })
 const creator=createPdfDocumentCreator({prepare:async()=>{
  const bound=await client.bindSession(oldProof)
  return {docxEditable:false,save:async()=>bound.request('/api/v1/files/uploads','POST',{})}
 },loadFont:async()=>new Uint8Array([1]),renderPdf:async()=>{currentProof=newProof;return new Uint8Array([1])}})
 await assert.rejects(creator(input));assert.equal(writes,0)
 await assert.rejects(creator(input),/not confirmed/);assert.equal(writes,0)
})
test('a stale PDF tool cannot bind to an account already changed before generation starts',async()=>{
 const {createLocalShellClient}=await import('../../src/shell/local-client.ts')
 const client=createLocalShellClient(async()=>Response.json({csrfToken:'b'.repeat(43)}))
 const creator=createPdfDocumentCreator({prepare:async()=>{
  const bound=await client.bindSession('a'.repeat(43))
  return {docxEditable:false,save:async()=>bound.request('/api/v1/files/uploads','POST',{})}
 },loadFont:async()=>assert.fail('must reject stale source identity before generation')})
 await assert.rejects(creator(input),/登录状态/)
})
test('the default creator renders a real PDF and waits for its saved revision receipt',async()=>{
 const {JSDOM}=await import('jsdom'),{readFile}=await import('node:fs/promises'),{PDFDocument}=await import('pdf-lib')
 const previousParser=globalThis.DOMParser;globalThis.DOMParser=new JSDOM('').window.DOMParser
 try{
  let saved=false
  const creator=createPdfDocumentCreator({prepare:async()=>({docxEditable:false,save:async value=>{
   const pdf=await PDFDocument.load(await value.file.arrayBuffer());assert.equal(pdf.getTitle(),input.title);assert.ok(pdf.getPageCount()>0);saved=true;return receipt
  }}),loadFont:async()=>new Uint8Array(await readFile(new URL('../../../docs/src/renderer/fonts/NotoSansCJKsc-Regular-subset.woff2',import.meta.url)))})
  assert.deepEqual(await creator(input),receipt);assert.equal(saved,true)
 }finally{if(previousParser===undefined)delete globalThis.DOMParser;else globalThis.DOMParser=previousParser}
})
