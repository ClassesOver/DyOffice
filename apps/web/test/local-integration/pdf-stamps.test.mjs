import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {mkdir,writeFile} from 'node:fs/promises'
import {PDFDocument,PDFName,PDFDict,degrees,rgb} from 'pdf-lib'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {createLeaseService} from '../../server/src/modules/leases/service.ts'
import {createRevisionService} from '../../server/src/modules/revisions/service.ts'
import {createPdfService} from '../../server/src/modules/pdf/service.ts'
import {readPdfLeafObjects} from '../../../pdf/src/main/text-edit.ts'
const text=async bytes=>(await readPdfLeafObjects(bytes)).filter(item=>item.type===1).map(item=>item.text).join('|')
async function state(bytes){const d=await PDFDocument.load(bytes);return d.getPages().map(p=>({rotation:p.getRotation().angle,crop:p.getCropBox(),unit:p.node.lookup(PDFName.of('UserUnit'))?.asNumber(),annotation:String(p.node.get(PDFName.of('Annots')))}))}
test('PDF stamps stage and commit replacements/removal across rotated pages while retaining original content and historical bytes',async t=>{
 const f=await fileFixture(t,{buildApp:false}),doc=await PDFDocument.create()
 for(const rotation of [0,90,180,270]){
  const page=doc.addPage([500,600]);page.setCropBox(20,30,450,540);page.setRotation(degrees(rotation));page.node.set(PDFName.of('UserUnit'),doc.context.obj(2))
  page.drawText('Native watermark',{x:80,y:320,size:18,color:rgb(.4,.4,.4)})
  page.drawText('Original body',{x:55,y:190,size:14})
  const note=doc.context.register(doc.context.obj({Type:'Annot',Subtype:'Text',Rect:[70,80,90,100],Contents:'Original note'}));page.node.set(PDFName.of('Annots'),doc.context.obj([note]))
 }
 const original=Buffer.from(await doc.save()),source=(await importFile(f,f.alice.token,original,'managed-stamps.pdf')).file
 const leases=createLeaseService({transactions:f.transactions}),revisions=createRevisionService({transactions:f.transactions,objects:f.objects,files:f.files}),pdf=createPdfService({files:f.files,leases,revisions})
 const editorId=randomUUID(),lease=await leases.acquireLease(f.alice.token,source.fileId,{editorId});let revision=source.revision
 const originals=await state(original),bodies=await text(original)
 const write=async(operation,kinds)=>{
  const staged=await pdf.stageStamps(f.alice.token,source.fileId,{baseRevision:revision,editorId,leaseEpoch:lease.leaseEpoch,idempotencyKey:randomUUID(),operation})
  assert.equal((await f.files.openFile(f.alice.token,source.fileId)).file.revision,revision,'staging must not publish')
  const saved=await revisions.commitRevision(f.alice.token,staged.commitInput);assert.deepEqual(await revisions.commitRevision(f.alice.token,staged.commitInput),saved,'same receipt is idempotent');revision=saved.revision
  const bytes=await f.files.readFile(f.alice.token,source.fileId,revision);assert.deepEqual(await state(bytes),originals)
  const d=await PDFDocument.load(bytes)
  for(const page of d.getPages()){
   const meta=page.node.lookupMaybe(PDFName.of('DyOfficeStamps'),PDFDict)
   for(const kind of ['Watermark','HeaderFooter'])assert.equal(!!meta?.has(PDFName.of(kind)),kinds.includes(kind))
   const xo=page.node.Resources()?.lookupMaybe(PDFName.of('XObject'),PDFDict)
   assert.equal(xo?.keys().filter(key=>String(key).startsWith('/DyOfficeStamp_')).length??0,kinds.length,'one resource per active configuration')
  }
  return bytes
 }
 const first=await write({op:'set_watermark',text:'内部草稿'},['Watermark']);assert.equal((await text(first)).match(/内部草稿/g)?.length,4)
 const replaced=await write({op:'set_watermark',text:'最终版'},['Watermark']);assert.doesNotMatch(await text(replaced),/内部草稿/)
 const both=await write({op:'set_header_footer',header_left:'项目文档',page_number:true,start_at:0},['Watermark','HeaderFooter']);assert.match(await text(both),/0 \/ 4/);assert.match(await text(both),/3 \/ 4/)
 const footer=await write({op:'set_watermark',text:''},['HeaderFooter']);assert.doesNotMatch(await text(footer),/最终版/)
 const removed=await write({op:'set_header_footer'},[]);assert.equal(await text(removed),bodies)
 const base={baseRevision:revision,editorId,leaseEpoch:lease.leaseEpoch,idempotencyKey:randomUUID(),operation:{op:'set_watermark',text:'x'}}
 await assert.rejects(pdf.stageStamps(f.bob.token,source.fileId,base),e=>e.statusCode===404)
 await assert.rejects(pdf.stageStamps(f.alice.token,source.fileId,{...base,leaseEpoch:lease.leaseEpoch+1}),e=>e.statusCode===409)
 await assert.rejects(pdf.stageStamps(f.alice.token,source.fileId,{...base,operation:{op:'set_watermark',text:''}}),e=>e.statusCode===400&&e.detail==='PDF_STAMP_NOT_FOUND')
 assert.equal((await f.files.openFile(f.alice.token,source.fileId)).file.revision,revision)
 assert.deepEqual(await f.files.readFile(f.alice.token,source.fileId,source.revision),original)
 const directory='/tmp/dyoffice-pdf-stamps-review';await mkdir(directory,{recursive:true})
 for(const [name,bytes] of Object.entries({original,first,replaced,both,removed}))await writeFile(`${directory}/${name}.pdf`,bytes)
})
