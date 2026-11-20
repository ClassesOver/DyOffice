import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {PDFDocument} from 'pdf-lib'
import {createIsolatedPdfFormFieldsJob} from '../server/src/pdf/form-fields-isolated.mjs'

test('isolated PDF field creation returns input-bound native bytes and aborts without returning a result',async()=>{
 const doc=await PDFDocument.create();doc.addPage([300,400]);const input=Buffer.from(await doc.save()),raw=JSON.stringify({version:1,action:'formFields',operations:[{op:'addFormField',field:{name:'Reviewer',kind:'text',page:1,x:30,y:50,width:150,height:24,value:'张三'}}]})
 const result=await createIsolatedPdfFormFieldsJob().execute(input,raw)
 assert.equal(result.inputSha256,createHash('sha256').update(input).digest('hex'));assert.equal(result.sha256,createHash('sha256').update(result.bytes).digest('hex'));assert.equal(result.size,result.bytes.length)
 assert.equal((await PDFDocument.load(result.bytes)).getForm().getTextField('Reviewer').getText(),'张三')
 const controller=new AbortController(),pending=createIsolatedPdfFormFieldsJob().execute(input,raw,controller.signal);controller.abort();await assert.rejects(pending,{code:'ABORTED'})
})
