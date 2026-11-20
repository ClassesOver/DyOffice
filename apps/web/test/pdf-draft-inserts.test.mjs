import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID,createHash} from 'node:crypto'
import {PDFDocument,PDFName,degrees} from 'pdf-lib'
import {PNG} from 'pngjs'
import {createPdfService} from '../server/src/modules/pdf/service.ts'
import {readPdfLeafObjects} from '../../pdf/src/main/text-edit.ts'
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
test('pending image preview is read-only and mixed inserts stage a single receipt with real native content',async()=>{
 const doc=await PDFDocument.create();for(const rotation of [0,90,180,270]){const page=doc.addPage([500,600]);page.setCropBox(20,30,450,540);page.setRotation(degrees(rotation));page.node.set(PDFName.of('UserUnit'),doc.context.obj(2));page.drawText('Source Anchor',{x:50,y:300,size:14})}
 const bytes=Buffer.from(await doc.save()),revision=randomUUID(),fileId=randomUUID(),editorId=randomUUID(),calls=[],png=new PNG({width:3,height:2});png.data.fill(255);const image={base64:PNG.sync.write(png).toString('base64'),mime:'image/png'},images=[1,2,3,4].flatMap(page=>[{page,image,x:30,y:50,width:100,height:40,layer:'above_text'},{page,image,x:200,y:180,width:70,height:90,layer:'below_text'}])
 const files={async openFile(token){if(token!=='owner')throw Object.assign(Error('forbidden'),{statusCode:404});return {format:'pdf',file:{revision,sha256:hash(bytes)}}},async download(){return {format:'pdf',bytes}},async receiveUpload(_t,_id,output){calls.push(['bytes',output])},async cancelUpload(){}},leases={async getLease(){calls.push(['lease']);return {active:true,heldByCurrentSession:true,editorId,leaseEpoch:1}}},revisions={async stageUpload(_t,_f,input){calls.push(['stage',input]);return {uploadId:'draft-upload'}}},service=createPdfService({files,leases,revisions})
 for(const operation of images){const report=await service.queryImageInserts('owner',fileId,{revision,operation});assert.equal(report.revision,revision);assert.deepEqual(report.image,{page:operation.page,x:operation.x,y:operation.y,width:operation.width,height:operation.height,layer:operation.layer,pixelWidth:3,pixelHeight:2})}
 assert.deepEqual(calls,[]);await assert.rejects(service.queryImageInserts('other',fileId,{revision,operation:images[0]}),error=>error.statusCode===404)
 const operation={texts:[1,2,3,4].map(page=>({page,text:'Draft text',x:40,y:80})),images},result=await service.stageDraftInserts('owner',fileId,{baseRevision:revision,editorId,leaseEpoch:1,idempotencyKey:'draft-mixed-test',operation})
 assert.equal(calls.filter(call=>call[0]==='stage').length,1);assert.equal(calls.filter(call=>call[0]==='bytes').length,1);assert.deepEqual(result.commitInput,{fileId,uploadId:'draft-upload',baseRevision:revision,leaseEpoch:1,idempotencyKey:'draft-mixed-test'})
 const output=calls.find(call=>call[0]==='bytes')[1],leaves=await readPdfLeafObjects(output);assert.equal(leaves.filter(item=>item.type===3).length,8);assert.equal(leaves.filter(item=>item.type===1&&item.text?.trim()==='Draft text').length,4);assert.equal(leaves.filter(item=>item.type===1&&item.text?.trim()==='Source Anchor').length,4);assert.equal(result.sha256,hash(output));assert.equal(hash(bytes),hash(Buffer.from(await doc.save())))
})

test('draft raster preview uses final native below/above layering and independent height, with unchanged source bytes',async()=>{
 const {createPdfDraftInsertsJob}=await import('../server/src/pdf/draft-inserts-job.mjs'),{createIsolatedPdfDraftInsertsQueryJob}=await import('../server/src/pdf/draft-inserts-isolated.mjs'),{mkdtemp,writeFile,readFile,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path'),{execFile}=await import('node:child_process'),{promisify}=await import('node:util')
 const doc=await PDFDocument.create();for(const angle of [0,90,180,270]){const p=doc.addPage([500,600]);p.setCropBox(20,30,450,540);p.setRotation(degrees(angle));p.node.set(PDFName.of('UserUnit'),doc.context.obj(2));p.drawText('Source text',{x:50,y:300,size:18})}
 const original=Buffer.from(await doc.save()),digest=hash(original),png=new PNG({width:2,height:2});png.data.set([220,20,30,255,20,220,30,128,20,30,220,255,230,230,20,255]);const image={base64:PNG.sync.write(png).toString('base64'),mime:'image/png'},operation={texts:[1,2,3,4].map(page=>({page,text:'Draft text',x:60,y:80})),images:[1,2,3,4].flatMap(page=>[{page,image,x:45,y:60,width:140,height:80,layer:'below_text'},{page,image,x:250,y:60,width:70,height:120,layer:'above_text'}])},raw=action=>JSON.stringify({version:1,action,operation})
 const preview=JSON.parse((await createIsolatedPdfDraftInsertsQueryJob().execute(original,raw('draftInsertsQuery'))).bytes),saved=await createPdfDraftInsertsJob('draftInserts').execute(original,raw('draftInserts'))
 assert.equal(preview.pages.length,4);assert.deepEqual(preview.pages.map(p=>[p.width,p.height]),[[900,1080],[1080,900],[900,1080],[1080,900]]);assert.equal(hash(original),digest)
 // Independently render the saved native artifact with Poppler: solid image interiors
 // must agree with the preview (font rasterizers may differ at glyph edges).
 const dir=await mkdtemp(join(tmpdir(),'dyoffice-draft-raster-'))
 try{await writeFile(join(dir,'saved.pdf'),saved.bytes);await promisify(execFile)('pdftoppm',['-cropbox','-r','144','-png',join(dir,'saved.pdf'),join(dir,'saved')],{timeout:15000})
  for(const page of preview.pages){const actual=PNG.sync.read(Buffer.from(page.png,'base64')),expected=PNG.sync.read(await readFile(join(dir,`saved-${page.page}.png`)));assert.equal(actual.width,expected.width);assert.equal(actual.height,expected.height);for(const [x,y]of [[260,70],[300,170],[50,65]]){const i=(y*actual.width+x)*4;assert.deepEqual(actual.data.subarray(i,i+4),expected.data.subarray(i,i+4))}}
 }finally{await rm(dir,{recursive:true,force:true})}
})

test('mixed drafts preserve managed stamps, allow images-only/text-only and reject bounded invalid batches or cancellation',async()=>{
 const {createPdfDraftInsertsJob,validatePdfDraftInserts,validatePdfPendingImageInsert}=await import('../server/src/pdf/draft-inserts-job.mjs'),{createIsolatedPdfDraftInsertsJob}=await import('../server/src/pdf/draft-inserts-isolated.mjs'),{createPdfStampsJob}=await import('../server/src/pdf/stamps-job.mjs')
 const d=await PDFDocument.create();d.addPage([400,400]).drawText('Source',{x:20,y:250,size:14});const source=Buffer.from(await d.save()),png=new PNG({width:1,height:1});png.data.set([20,80,220,128]);const image={base64:PNG.sync.write(png).toString('base64'),mime:'image/png'},insert={page:1,image,x:30,y:40,width:40,height:90,layer:'below_text'},stamp=async(bytes,text)=>(await createPdfStampsJob().execute(bytes,JSON.stringify({version:1,action:'stamps',operation:{op:'set_watermark',text,angle:0,size:.04}}))).bytes,managed=await stamp(source,'Managed')
 for(const operation of [{texts:[],images:[insert]},{texts:[{page:1,text:'Text only',x:30,y:100}],images:[]},{texts:[{page:1,text:'Mixed text',x:30,y:100}],images:[insert]}]){
  const output=await createPdfDraftInsertsJob('draftInserts').execute(managed,JSON.stringify({version:1,action:'draftInserts',operation})),removed=await stamp(output.bytes,''),leaves=await readPdfLeafObjects(removed);assert.equal(leaves.filter(item=>item.type===3).length,operation.images.length);assert.ok(leaves.some(item=>item.text?.trim()==='Source'));assert.ok(!leaves.some(item=>item.text?.includes('Managed')))
 }
 for(const operation of [{texts:[],images:[]},{texts:Array(21).fill({page:1,text:'x'}),images:[]},{texts:[],images:Array(21).fill(insert)}])assert.throws(()=>validatePdfDraftInserts(operation),{code:'INVALID_PDF_DRAFT_INSERTS'})
 for(const patch of [{height:0},{height:Infinity},{unknown:1},{op:'insert_image'}])assert.throws(()=>validatePdfPendingImageInsert({...insert,...patch}),{code:'INVALID_PDF_IMAGE_CONTENT'})
 const big=Buffer.alloc(5*1024*1024).toString('base64');assert.throws(()=>validatePdfDraftInserts({texts:[],images:Array(5).fill({...insert,image:{base64:big,mime:'image/png'}})}),{code:'PDF_IMAGE_CONTENT_LIMIT'})
 const controller=new AbortController(),pending=createIsolatedPdfDraftInsertsJob().execute(source,JSON.stringify({version:1,action:'draftInserts',operation:{texts:[],images:[insert]}}),controller.signal);controller.abort();await assert.rejects(pending,{code:'ABORTED'})
})

test('image draft geometry supports height-only aspect ratio and raster refuses viewer-sized pixel limits before allocation',async()=>{
 const {createPdfDraftInsertsJob}=await import('../server/src/pdf/draft-inserts-job.mjs'),d=await PDFDocument.create();d.addPage([500,600]).drawText('Anchor',{x:40,y:300,size:14});const bytes=Buffer.from(await d.save()),png=new PNG({width:3,height:2});png.data.fill(255);const image={base64:PNG.sync.write(png).toString('base64'),mime:'image/png'},operation={page:1,image,height:80,anchor_text:'Anchor',placement:'below'}
 const result=JSON.parse((await createPdfDraftInsertsJob('imageInsertsQuery').execute(bytes,JSON.stringify({version:1,action:'imageInsertsQuery',operation}))).bytes);assert.equal(result.image.width,120);assert.equal(result.image.height,80);assert.equal(result.image.layer,'below_text');assert.ok(result.image.y>300-14)
 const huge=await PDFDocument.create();huge.addPage([5000,5000]).drawText('Original',{x:20,y:40,size:12});await assert.rejects(createPdfDraftInsertsJob('draftInsertsQuery').execute(Buffer.from(await huge.save()),JSON.stringify({version:1,action:'draftInsertsQuery',operation:{texts:[],images:[{page:1,image,width:20,x:20,y:20}]}})),{code:'PDF_IMAGE_BAKE_LIMIT'})
})


test('native pending image query exposes the raw writer edit for every rotation CropBox and UserUnit',async()=>{
 const {createPdfDraftInsertsJob}=await import('../server/src/pdf/draft-inserts-job.mjs'),{applySaveRequest}=await import('../../pdf/src/main/save-pdf.ts'),{decodePdfImage}=await import('../server/src/pdf/image-content-job.mjs'),{viewToPdf}=await import('../../pdf/src/renderer/annotations.ts'),doc=await PDFDocument.create()
 for(const rotation of [0,90,180,270]){const page=doc.addPage([500,600]);page.setCropBox(20,30,450,540);page.setRotation(degrees(rotation));page.node.set(PDFName.of('UserUnit'),doc.context.obj(2));page.drawText('Preserved',{x:40,y:300})}
 const original=Buffer.from(await doc.save()),head=hash(original),png=new PNG({width:3,height:2});png.data.fill(255);const image={base64:PNG.sync.write(png).toString('base64'),mime:'image/png'}
 for(let page=1;page<=4;page++){const operation={page,image,x:30,y:50,width:100,height:40,layer:page%2?'above_text':'below_text'},query=await createPdfDraftInsertsJob('imageInsertsQuery').execute(original,JSON.stringify({version:1,action:'imageInsertsQuery',operation})),report=JSON.parse(query.bytes),geom={pw:900,ph:1080,x0:20,y0:30,userUnit:2,rot:(page-1)*90},a=viewToPdf(geom,30,50),b=viewToPdf(geom,130,90)
  assert.deepEqual(report.edit,{kind:'insertImage',pageIndex:page-1,rect:[Math.min(a[0],b[0]),Math.min(a[1],b[1]),Math.max(a[0],b[0]),Math.max(a[1],b[1])],rotate:(page-1)*90,layer:page%2?'aboveText':'belowText',image:image.base64});assert.deepEqual(report.image,{page,x:30,y:50,width:100,height:40,layer:operation.layer,pixelWidth:3,pixelHeight:2});assert.equal(query.inputSha256,head)
  const applied=await applySaveRequest(original,{formValues:[],markups:[],drawings:[],rotations:[],imageEdits:[report.edit]},{decodeImage:()=>decodePdfImage(image)}),saved=await createPdfDraftInsertsJob('draftInserts').execute(original,JSON.stringify({version:1,action:'draftInserts',operation:{texts:[],images:[operation]}}))
  assert.deepEqual(await readPdfLeafObjects(applied.bytes),await readPdfLeafObjects(saved.bytes));assert.equal(hash(original),head)
 }
})
