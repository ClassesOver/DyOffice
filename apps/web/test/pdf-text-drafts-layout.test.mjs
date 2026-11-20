import test from 'node:test'
import assert from 'node:assert/strict'
import {PDFDocument} from 'pdf-lib'
import {createPdfTextDrafts} from '../src/editors/pdf-text-drafts.ts'
import {createPdfTextInsertsQueryJob,createPdfTextInsertsJob} from '../server/src/pdf/text-inserts-job.mjs'
import {readPdfLeafObjects} from '../../pdf/src/main/text-edit.ts'

test('mixed-script pending blocks reflow together and save the same native line layout after deletion and undo',async()=>{
 const doc=await PDFDocument.create();doc.addPage([500,600])
 const original=Buffer.from(await doc.save()),query=createPdfTextInsertsQueryJob()
 const drafts=createPdfTextDrafts({fileId:'pdf',getRevision:()=> 'revision',isReady:()=>true,onChange(){},request:async(_path,_method,body)=>{
  const result=await query.execute(original,JSON.stringify({version:1,action:'textInsertsQuery',operations:body.operations}))
  return {revision:body.revision,...JSON.parse(result.bytes.toString())}
 }})
 const latin=await drafts.insert({page:1,text:'WWWW iiiii Hello',x:40,y:40,font_size:16,max_width:130})
 assert.equal(latin.text.split('\n').length,2)
 const cjk=await drafts.insert({page:1,text:'中文测试',x:40,y:140,font_size:16})
 assert.equal(drafts.list()[0].text,'WWWW iiiii Hello')
 await drafts.remove(cjk.id)
 assert.equal(drafts.list()[0].text,latin.text)
 assert.equal(drafts.undo(),true)
 assert.deepEqual(drafts.list().map(block=>block.id),[latin.id,cjk.id])
 const preview=drafts.list(),saved=await createPdfTextInsertsJob().execute(original,JSON.stringify({version:1,action:'textInserts',operations:drafts.operations()}))
 const leaves=(await readPdfLeafObjects(saved.bytes)).filter(item=>item.type===1)
 assert.deepEqual(leaves.map(item=>item.text),preview.flatMap(block=>block.text.split('\n')))
 for(const block of preview){
  const leaf=leaves.find(item=>item.text===block.text)
  assert.ok(leaf)
  assert.ok(Math.abs(leaf.matrix[4]-block.x)<.01)
  assert.ok(Math.abs(leaf.matrix[5]-(600-block.y-block.font_size))<.01)
 }
})
