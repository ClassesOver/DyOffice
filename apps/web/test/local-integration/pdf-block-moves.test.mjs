import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {mkdir,writeFile} from 'node:fs/promises'
import {PDFDocument,degrees,StandardFonts,rgb} from 'pdf-lib'
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {createLeaseService} from '../../server/src/modules/leases/service.ts'
import {createRevisionService} from '../../server/src/modules/revisions/service.ts'
import {createPdfService} from '../../server/src/modules/pdf/service.ts'
async function positions(bytes){
 const task=getDocument({data:Uint8Array.from(bytes),disableFontFace:true,useSystemFonts:true})
 try{const doc=await task.promise,out=[];for(let n=1;n<=doc.numPages;n++){const page=await doc.getPage(n),viewport=page.getViewport({scale:1}),content=await page.getTextContent();out.push(content.items.filter(item=>item.str).map(item=>({text:item.str,point:viewport.convertToViewportPoint(item.transform[4],item.transform[5]),height:item.height,width:item.width,font:content.styles[item.fontName]?.fontFamily}))) }return out}finally{await task.destroy()}
}
test('PDF paragraph move saves displayed offsets on rotated pages without rewriting text or earlier revisions',async t=>{
 const f=await fileFixture(t,{buildApp:false}),doc=await PDFDocument.create(),font=await doc.embedFont(StandardFonts.TimesRomanItalic)
 for(const rotation of [0,90]){const page=doc.addPage([500,400]);page.setRotation(degrees(rotation));page.drawText('Move this original paragraph.',{x:40,y:300,size:14,font,color:rgb(.1,.2,.6)});page.drawText('Keep this footer.',{x:40,y:70,size:12});page.drawRectangle({x:300,y:50,width:40,height:20,color:rgb(.2,.7,.3)})}
 const original=Buffer.from(await doc.save()),source=(await importFile(f,f.alice.token,original,'move.pdf')).file
 const leases=createLeaseService({transactions:f.transactions}),revisions=createRevisionService({transactions:f.transactions,objects:f.objects,files:f.files}),pdf=createPdfService({files:f.files,leases,revisions})
 const editorId=randomUUID(),lease=await leases.acquireLease(f.alice.token,source.fileId,{editorId}),operations=[{page:1,paragraph_text:'Move this original',dx:30,dy:20},{page:2,paragraph_text:'Move this original',dx:-20,dy:35}]
 const input={baseRevision:source.revision,editorId,leaseEpoch:lease.leaseEpoch,idempotencyKey:randomUUID(),operations}
 await assert.rejects(pdf.stageBlockMoves(f.bob.token,source.fileId,input),error=>error.statusCode===404)
 await assert.rejects(pdf.stageBlockMoves(f.alice.token,source.fileId,{...input,leaseEpoch:lease.leaseEpoch+1}),error=>error.statusCode===409)
 await assert.rejects(pdf.stageBlockMoves(f.alice.token,source.fileId,{...input,operations:[operations[0],{...operations[1],paragraph_text:'Missing'}]}),error=>error.statusCode===400)
 const staged=await pdf.stageBlockMoves(f.alice.token,source.fileId,input)
 assert.equal((await f.files.openFile(f.alice.token,source.fileId)).file.revision,source.revision)
 const saved=await revisions.commitRevision(f.alice.token,staged.commitInput)
 assert.deepEqual(await revisions.commitRevision(f.alice.token,staged.commitInput),saved)
 const output=await f.files.readFile(f.alice.token,source.fileId,saved.revision),before=await positions(original),after=await positions(output)
 for(let i=0;i<2;i++)for(const item of before[i]){
  const actual=after[i].find(other=>other.text===item.text);assert.ok(actual)
  const delta=item.text.startsWith('Move')?[operations[i].dx,operations[i].dy]:[0,0]
  assert.ok(Math.abs(actual.point[0]-item.point[0]-delta[0])<.1);assert.ok(Math.abs(actual.point[1]-item.point[1]-delta[1])<.1)
  assert.equal(actual.font,item.font);assert.ok(Math.abs(actual.width-item.width)<.1);assert.ok(Math.abs(actual.height-item.height)<.1)
 }
 assert.deepEqual(await f.files.readFile(f.alice.token,source.fileId,source.revision),original)
 await mkdir('/tmp/dyoffice-pdf-move-review',{recursive:true});await writeFile('/tmp/dyoffice-pdf-move-review/moved.pdf',output)
})
