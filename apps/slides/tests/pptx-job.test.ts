// @vitest-environment node
import {describe,it,expect} from 'vitest'
import JSZip from 'jszip'
import {createHash} from 'node:crypto'
import {addElement,createBlankPptx,openPptx,savePptx} from '@genoffice/pptx-engine'
import {elementDurableId} from '@genoffice/pptx-ops'
import {createPptxJobProcessor} from '../../web/worker/src/native/pptx-job'
async function fixture(){
 const p=await openPptx(await createBlankPptx())
 addElement(p.deck.slides[0]!,{kind:'textbox',offset:{x:0,y:0,cx:1828800,cy:914400},paragraphs:[{runs:[{text:'before'}]}]})
 const bytes=await savePptx(p), opened=await openPptx(bytes)
 return {bytes,id:elementDurableId(opened.deck.slides[0]!.elements.find(e=>e.type==='text'||e.type==='shape')!)!}
}
const request=(id:string)=>JSON.stringify({version:1,action:'setText',ops:[{op:'setText',target:{slide:0,el:id},paragraphs:[{runs:[{text:'after'}]}]}]})
describe('private one-shot PPTX job protocol',()=>{
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
 it('cancels before and during work without emitting output; capacity recovers',async()=>{
  const {bytes}=await fixture(), job=createPptxJobProcessor(),controller=new AbortController()
  const running=job.execute(bytes,'{"version":1,"action":"roundtrip"}',controller.signal)
  controller.abort()
  await expect(running).rejects.toMatchObject({code:'ABORTED'})
  await expect(job.execute(bytes,'{"version":1,"action":"roundtrip"}',controller.signal)).rejects.toMatchObject({code:'ABORTED'})
  await expect(job.execute(bytes,'{"version":1,"action":"roundtrip"}')).resolves.toHaveProperty('sha256')
 })
})
