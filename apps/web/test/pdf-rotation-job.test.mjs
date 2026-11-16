import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {PDFDocument} from 'pdf-lib'
import {createPdfRotationJob} from '../server/src/pdf/rotation-job.mjs'
const request = JSON.stringify({version:1,action:'rotatePages',operations:[{page:1,degrees:90}]})
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
async function fixture() {const doc=await PDFDocument.create();doc.addPage([200,100]);return Buffer.from(await doc.save())}

test('returns real rotated bytes with input/output identities, not a save receipt',async()=>{
  const bytes=await fixture(),out=await createPdfRotationJob().execute(bytes,request)
  assert.equal(out.inputSha256,hash(bytes))
  assert.equal(out.sha256,hash(out.bytes))
  assert.equal(out.size,out.bytes.length)
  assert.equal((await PDFDocument.load(out.bytes)).getPage(0).getRotation().angle,90)
  assert.deepEqual(Object.keys(out).sort(),['bytes','inputSha256','sha256','size'])
})

test('strict request refuses paths, credential fields, unknown versions and actions',async()=>{
  const bytes=await fixture(),job=createPdfRotationJob()
  for(const value of ['bad',JSON.stringify({version:2,action:'rotatePages',operations:[]}),JSON.stringify({version:1,action:'redact',operations:[]}),JSON.stringify({...JSON.parse(request),path:'/tmp/anything'}),JSON.stringify({...JSON.parse(request),token:'secret'}),JSON.stringify({...JSON.parse(request),operations:[]})]) {
    await assert.rejects(job.execute(bytes,value),{code:'INVALID_REQUEST'})
  }
  await assert.rejects(job.execute(bytes,' '.repeat(65537)),{code:'REQUEST_LIMIT'})
  await assert.rejects(job.execute(bytes,'中'.repeat(30000)),{code:'REQUEST_LIMIT'})
})

test('single active task rejects overlap without queueing and permits a later task',async()=>{
  const bytes=await fixture(),job=createPdfRotationJob()
  const first=job.execute(bytes,request)
  await assert.rejects(job.execute(bytes,request),{code:'BUSY'})
  await first
  assert.ok((await job.execute(bytes,request)).bytes.length)
})

test('abort before or during parse never returns an export; later jobs still work',async()=>{
  const bytes=await fixture(),job=createPdfRotationJob(),controller=new AbortController()
  controller.abort()
  await assert.rejects(job.execute(bytes,request,controller.signal),{code:'ABORTED'})
  const next=new AbortController(),pending=job.execute(bytes,request,next.signal)
  next.abort()
  await assert.rejects(pending,{code:'ABORTED'})
  assert.ok((await job.execute(bytes,request)).bytes.length)
})

test('captures caller buffer and shields parser details from failures',async()=>{
  const bytes=await fixture(),expected=hash(bytes),job=createPdfRotationJob()
  const pending=job.execute(bytes,request);bytes.fill(0)
  assert.equal((await pending).inputSha256,expected)
  await assert.rejects(job.execute(Buffer.from('%PDF-private secret'),request),e=>e.code==='NATIVE_FAILED'&&!e.message.includes('private secret'))
  assert.ok((await job.execute(await fixture(),request)).bytes.length)
})

test('invalid operation remains rejected and typed safety refusals are preserved',async()=>{
  const bytes=await fixture(),job=createPdfRotationJob()
  await assert.rejects(job.execute(bytes,JSON.stringify({version:1,action:'rotatePages',operations:[{page:1,degrees:45}]})),{code:'INVALID_PDF_ROTATION'})
  const form=await PDFDocument.load(bytes);form.getForm().createTextField('x')
  await assert.rejects(job.execute(Buffer.from(await form.save()),request),{code:'PDF_EDIT_UNSUPPORTED_STRUCTURE'})
  const signed=await PDFDocument.load(bytes)
  signed.context.register(signed.context.obj({Type:'Sig',ByteRange:[0,1,2,3]}))
  await assert.rejects(job.execute(Buffer.from(await signed.save()),request),{code:'SIGNATURE_EDIT_REFUSED'})
})

test('rejects empty, nonbuffer and oversized input before parsing',async()=>{
  const job=createPdfRotationJob()
  for(const bytes of [null,new Uint8Array([1]),Buffer.alloc(0),Buffer.alloc(64*1024*1024+1)]) {
    await assert.rejects(job.execute(bytes,request),{code:'INPUT_LIMIT'})
  }
})
