import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {PDFDocument} from 'pdf-lib'
import {createPdfApplyOpsQueryJob,parsePdfApplyOpsQueryRequest} from '../server/src/pdf/apply-ops-query-job.mjs'
import {createIsolatedPdfApplyOpsQueryJob} from '../server/src/pdf/apply-ops-query-isolated.mjs'
const hash=b=>createHash('sha256').update(b).digest('hex')
async function fixture(){const d=await PDFDocument.create();d.addPage([300,400]);d.addPage([400,500]);return Buffer.from(await d.save())}
const snapshot=()=>({fileId:randomUUID(),baseRevision:randomUUID(),generation:3,markups:[],notes:[{id:'Pn',input:{kind:'note',pageIndex:1,at:[40,100],color:[1,1,0],contents:'Pending note'}}],textInserts:[],imageEdits:[],formEdits:{},formFields:[],rotations:{0:90},deleted:[],order:[1,0],metadata:{title:'Preview only'}})
const raw=s=>JSON.stringify({version:1,action:'applyOpsQuery',snapshot:s})
async function verify(result,input){assert.equal(result.inputSha256,hash(input));assert.equal(result.sha256,hash(result.bytes));assert.equal(result.size,result.bytes.length);const d=await PDFDocument.load(result.bytes);assert.equal(d.getTitle(),'Preview only');assert.equal(d.getPage(0).getRotation().angle,0);assert.equal(d.getPage(1).getRotation().angle,90);assert.equal(d.getPage(0).node.Annots().size(),1)}
test('unified preview compiles strict snapshot into temporary PDF and preserves source bytes',async()=>{const input=await fixture(),before=Buffer.from(input);await verify(await createPdfApplyOpsQueryJob().execute(input,raw(snapshot())),input);assert.deepEqual(input,before);assert.equal((await PDFDocument.load(input)).getTitle(),undefined)})
test('preview rejects hidden request options malformed snapshots and stale file protection',async()=>{
 const input=await fixture(),job=createPdfApplyOpsQueryJob(),s=snapshot()
 for(const value of [JSON.stringify({version:1,action:'applyOps',snapshot:s}),JSON.stringify({version:1,action:'applyOpsQuery',snapshot:s,path:'/tmp/x'}),raw({...s,path:'/tmp/x'})])assert.throws(()=>parsePdfApplyOpsQueryRequest(value))
 const d=await PDFDocument.load(input);d.context.register(d.context.obj({Type:'Sig',ByteRange:[0,1,2,3]}));await assert.rejects(job.execute(Buffer.from(await d.save()),raw(s)),{code:'SIGNATURE_EDIT_REFUSED'})
 const c=new AbortController();c.abort();await assert.rejects(job.execute(input,raw(s),c.signal),{code:'ABORTED'})
})
test('fixed isolated preview dispatch returns bound PDF and cancellation suppresses output',async()=>{
 const input=await fixture(),job=createIsolatedPdfApplyOpsQueryJob(),s=snapshot();await verify(await job.execute(input,raw(s)),input)
 const c=new AbortController(),pending=job.execute(input,raw(s),c.signal);c.abort();await assert.rejects(pending,{code:'ABORTED'})
})
