import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {PDFDocument} from 'pdf-lib'
import {createIsolatedPdfApplyOpsJob} from '../server/src/pdf/apply-ops-isolated.mjs'
import {readPdfLeafObjects} from '../../pdf/src/main/text-edit.ts'

test('isolated mixed snapshot writes input-bound bytes and cancellation never returns an output',async()=>{
 const doc=await PDFDocument.create();doc.addPage([300,400]);const input=Buffer.from(await doc.save())
 const snapshot={fileId:'74ad6054-8061-44ef-b42c-ef55e5bf851d',baseRevision:'4746fb72-4380-4d28-9802-86fa3b462807',generation:1,markups:[],notes:[],textInserts:[],imageEdits:[],formEdits:{},formFields:[],rotations:{0:90},deleted:[],order:null,metadata:{title:'One mixed write'}}
 const raw=JSON.stringify({version:1,action:'applyOps',snapshot}),job=createIsolatedPdfApplyOpsJob()
 const result=await job.execute(input,raw),hash=value=>createHash('sha256').update(value).digest('hex')
 assert.equal(result.inputSha256,hash(input));assert.equal(result.sha256,hash(result.bytes));assert.equal(result.size,result.bytes.length)
 const reopened=await PDFDocument.load(result.bytes);assert.equal(reopened.getTitle(),'One mixed write');assert.equal(reopened.getPage(0).getRotation().angle,90)
 const abort=new AbortController(),pending=job.execute(input,raw,abort.signal);abort.abort()
 await assert.rejects(pending,{code:'ABORTED'})
 await assert.rejects(job.execute(input,JSON.stringify({version:1,action:'applyOps',snapshot:{...snapshot,path:'/tmp/escape'}})),{code:'INVALID_PDF_APPLY_SNAPSHOT'})
})

test('many OCR lines can save with an ordinary insert without relaxing its limit',async()=>{
 const doc=await PDFDocument.create()
 doc.addPage([300,700]);doc.addPage([300,700])
 const input=Buffer.from(await doc.save())
 const entry=(index,page,invisible)=>({id:'T'+index,input:{
  pageIndex:page,origin:[30,650-(index%40)*16],text:(invisible?'OCR line ':'Visible line ')+index,fontSize:10,color:[0,0,0],invisible,
 }})
 const snapshot={fileId:'74ad6054-8061-44ef-b42c-ef55e5bf851d',baseRevision:'4746fb72-4380-4d28-9802-86fa3b462807',generation:1,
  markups:[],notes:[],textInserts:[entry(0,1,false),...Array.from({length:32},(_,i)=>entry(i+1,0,true))],
  imageEdits:[],formEdits:{},formFields:[],rotations:{},deleted:[],order:[1,0],metadata:null}
 const execute=textInserts=>createIsolatedPdfApplyOpsJob().execute(input,JSON.stringify({version:1,action:'applyOps',snapshot:{...snapshot,textInserts}}))
 const saved=await execute(snapshot.textInserts)
 const text=(await readPdfLeafObjects(saved.bytes)).filter(item=>item.type===1)
 assert.deepEqual(text.filter(item=>item.page===0).map(item=>[item.text,item.mode]),[['Visible line 0',0]])
 assert.equal(text.filter(item=>item.page===1&&item.mode===3).length,32)
 assert.equal(text.find(item=>item.text==='OCR line 32').page,1)
 await assert.rejects(execute(Array.from({length:21},(_,i)=>entry(i,0,false))),{code:'INVALID_PDF_APPLY_SNAPSHOT'})
})
