// @vitest-environment node
import {describe,it,expect} from 'vitest'
import JSZip from 'jszip'
import {createHash} from 'node:crypto'
import {addElement,createBlankPptx,openPptx,savePptx} from '@genoffice/pptx-engine'
import {elementDurableId} from '@genoffice/pptx-ops'
import {createPptxSession} from '../../web/worker/src/native/pptx-session'
import {createPptxJobProcessor} from '../../web/worker/src/native/pptx-job'
async function fixture(){
 const p=await openPptx(await createBlankPptx())
 addElement(p.deck.slides[0]!,{kind:'textbox',offset:{x:0,y:0,cx:1828800,cy:914400},paragraphs:[{runs:[{text:'before'}]}]})
 const bytes=await savePptx(p), opened=await openPptx(bytes)
 return {bytes,id:elementDurableId(opened.deck.slides[0]!.elements.find(e=>e.type==='text'||e.type==='shape')!)!}
}
const request=(id:string)=>JSON.stringify({version:1,action:'setText',ops:[{op:'setText',target:{slide:0,el:id},paragraphs:[{runs:[{text:'after'}]}]}]})
describe('private one-shot PPTX job protocol',()=>{
 it('reopens a saved output for a second edit without losing text, formatting or unrelated parts',async()=>{
  const {bytes,id}=await fixture(),original=await JSZip.loadAsync(bytes)
  let current=bytes
  const edits=[
   [{runs:[{text:'第一轮 <&> 😀',bold:true}]},{runs:[{text:'second paragraph',italic:true}]}],
   [{runs:[{text:'再次保存 <&> 😀',bold:true}]},{runs:[{text:'',italic:true}]}],
  ]
  for(const paragraphs of edits){
   // A new processor models a later independent job, not a retained session.
   const output=await createPptxJobProcessor().execute(current,JSON.stringify({version:1,action:'setText',ops:[{op:'setText',target:{slide:0,el:id},paragraphs}]}))
   expect(output.localGeneration).toBe(1)
   expect(output.sha256).toBe(createHash('sha256').update(output.bytes).digest('hex'))
   const reopened=await openPptx(output.bytes)
   const element=reopened.deck.slides[0]!.elements.find(e=>elementDurableId(e)===id)
   if(!element || !('text' in element))throw new Error('Saved text element missing')
   expect(element.text!.paragraphs.map(p=>p.runs.map(r=>r.text).join(''))).toEqual(paragraphs.map(p=>p.runs.map(r=>r.text).join('')))
   expect(element.text!.paragraphs[0]!.runs[0]!.bold).toBe(true)
   const saved=await JSZip.loadAsync(output.bytes)
   const names=Object.keys(original.files).filter(n=>!original.files[n]!.dir).sort()
   expect(Object.keys(saved.files).filter(n=>!saved.files[n]!.dir).sort()).toEqual(names)
   for(const name of names){
    if(name==='ppt/slides/slide1.xml')continue
    expect(await saved.files[name]!.async('uint8array'),name).toEqual(await original.files[name]!.async('uint8array'))
   }
   current=output.bytes
  }
 })
 it('returns reopened native output and digest without durable save acknowledgement',async()=>{
  const {bytes,id}=await fixture(), job=createPptxJobProcessor()
  const result=await job.execute(bytes,request(id))
  const p=await openPptx(result.bytes)
  expect(JSON.stringify(p.deck.slides)).toContain('after')
  expect(result.sha256).toBe(createHash('sha256').update(result.bytes).digest('hex'))
  expect(result.localGeneration).toBe(1)
  expect(Object.keys(result).sort()).toEqual(['bytes','localGeneration','sha256'])
 })
 it('preserves every archive part on roundtrip and unrelated parts on text edit',async()=>{
  const {bytes,id}=await fixture(),job=createPptxJobProcessor(),before=await JSZip.loadAsync(bytes)
  for(const raw of ['{"version":1,"action":"roundtrip"}',request(id)]){
   const after=await JSZip.loadAsync((await job.execute(bytes,raw)).bytes)
   const names=Object.keys(before.files).filter(n=>!before.files[n]!.dir).sort()
   expect(Object.keys(after.files).filter(n=>!after.files[n]!.dir).sort()).toEqual(names)
   for(const name of names){
    if(raw===request(id)&&name==='ppt/slides/slide1.xml')continue
    expect(await after.files[name]!.async('uint8array'),name).toEqual(await before.files[name]!.async('uint8array'))
   }
  }
 })
 it('snapshots input before yielding and rejects concurrent jobs without queuing',async()=>{
  const {bytes}=await fixture(), input=Uint8Array.from(bytes),job=createPptxJobProcessor()
  const running=job.execute(input,'{"version":1,"action":"roundtrip"}')
  void running.catch(()=>{})
  input.fill(0)
  await expect(job.execute(bytes,'{"version":1,"action":"roundtrip"}')).rejects.toMatchObject({code:'BUSY'})
  expect((await running).localGeneration).toBe(0)
  await expect(job.execute(bytes,'{"version":1,"action":"roundtrip"}')).resolves.toHaveProperty('sha256')
 })
 it.each([
  '{','null','[]','{"version":2,"action":"roundtrip"}',
  '{"version":1,"action":"roundtrip","path":"/etc/passwd"}',
  '{"version":1,"action":"roundtrip","ops":[]}',
  '{"version":1,"action":"setText","token":"secret","ops":[]}',
  '{"version":1,"action":"export"}',
 ])('rejects invalid protocol before work: %s',async raw=>{
  const {bytes}=await fixture()
  await expect(createPptxJobProcessor().execute(bytes,raw)).rejects.toMatchObject({code:'INVALID_REQUEST'})
 })
 it('bounds input and protocol independently',async()=>{
  const job=createPptxJobProcessor()
  await expect(job.execute(new Uint8Array(0),'{}')).rejects.toMatchObject({code:'INPUT_LIMIT'})
  await expect(job.execute(new Uint8Array(32*1024*1024+1),'{}')).rejects.toMatchObject({code:'INPUT_LIMIT'})
  await expect(job.execute(new Uint8Array([1]),'界'.repeat(100000))).rejects.toMatchObject({code:'REQUEST_LIMIT'})
 })
 it('does not echo native parser details or credential-like input',async()=>{
  await expect(createPptxJobProcessor().execute(new TextEncoder().encode('secret-document'),'{"version":1,"action":"roundtrip"}')).rejects.toMatchObject({code:'NATIVE_FAILED',message:'NATIVE_FAILED'})
 })
 it('rejects non-whitelisted mutations and resets capacity on failure',async()=>{
  const {bytes}=await fixture(), job=createPptxJobProcessor()
  await expect(job.execute(bytes,JSON.stringify({version:1,action:'setText',ops:[{op:'deleteSlide',target:{slide:0}}]}))).rejects.toMatchObject({code:'INVALID_OPERATION'})
  await expect(job.execute(bytes,'{"version":1,"action":"roundtrip"}')).resolves.toHaveProperty('sha256')
 })
 it.each([
  {op:'addBlankSlide',target:{slide:0}},
  {op:'setNotes',target:{slide:0},text:'unauthorized notes'},
 ])('setText envelope rejects other supported session operations: $op',async op=>{
  const {bytes}=await fixture(),job=createPptxJobProcessor()
  await expect(job.execute(bytes,JSON.stringify({version:1,action:'setText',ops:[op]}))).rejects.toMatchObject({code:'INVALID_OPERATION'})
  await expect(job.execute(bytes,'{"version":1,"action":"roundtrip"}')).resolves.toHaveProperty('sha256')
 })
 it('rejects an entire mixed batch before parsing document bytes',async()=>{
  const raw=JSON.stringify({version:1,action:'setText',ops:[
   {op:'setText',target:{slide:0,el:'e_test'},paragraphs:[{runs:[{text:'allowed'}]}]},
   {op:'addBlankSlide',target:{slide:0}},
  ]})
  await expect(createPptxJobProcessor().execute(new Uint8Array([1]),raw)).rejects.toMatchObject({code:'INVALID_OPERATION'})
 })
 it('setText cannot delete a valid slide from a real two-page deck',async()=>{
  const {bytes,id}=await fixture(),session=await createPptxSession(bytes)
  let multi:Uint8Array
  try{
   await session.apply(0,[{op:'addBlankSlide',target:{slide:0}}])
   multi=(await session.exportBytes(1)).bytes
  }finally{session.close()}
  expect((await openPptx(multi)).deck.slides).toHaveLength(2)
  // Establish that the underlying session really supports this operation; the
  // one-shot rejection must come from its narrower command contract.
  const control=await createPptxSession(multi)
  try{
   await control.apply(0,[{op:'deleteSlide',target:{slide:1}}])
   expect((await control.outline(1)).count).toBe(1)
  }finally{control.close()}
  const job=createPptxJobProcessor()
  await expect(job.execute(multi,JSON.stringify({version:1,action:'setText',ops:[{op:'deleteSlide',target:{slide:1}}]}))).rejects.toMatchObject({code:'INVALID_OPERATION'})
  const edited=await job.execute(multi,request(id)),opened=await openPptx(edited.bytes)
  expect(opened.deck.slides).toHaveLength(2)
  expect(JSON.stringify(opened.deck.slides[0])).toContain('after')
 })
 it('cancels before and during work without emitting output; capacity recovers',async()=>{
  const {bytes}=await fixture(), job=createPptxJobProcessor(),controller=new AbortController()
  const running=job.execute(bytes,'{"version":1,"action":"roundtrip"}',controller.signal)
  controller.abort()
  await expect(running).rejects.toMatchObject({code:'ABORTED'})
  await expect(job.execute(bytes,'{"version":1,"action":"roundtrip"}',controller.signal)).rejects.toMatchObject({code:'ABORTED'})
  await expect(job.execute(bytes,'{"version":1,"action":"roundtrip"}')).resolves.toHaveProperty('sha256')
 })
})
