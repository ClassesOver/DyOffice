import test from 'node:test'
import assert from 'node:assert/strict'
import {PDFDocument} from 'pdf-lib'
import {PNG} from 'pngjs'
import {createPdfDraftInsertsJob,validatePdfDraftInserts} from '../server/src/pdf/draft-inserts-job.mjs'
import {catalog} from '../server/src/pdf/image-edits-job.mjs'
import {readImageSource} from '../../pdf/src/main/image-edit.ts'
import {readPdfLeafObjects} from '../../pdf/src/main/text-edit.ts'
import {createPdfStampsJob} from '../server/src/pdf/stamps-job.mjs'
import {createPdfApplyOpsJob} from '../server/src/pdf/apply-ops-job.mjs'
import {pdfInsertFormState} from '../server/src/pdf/insert-form-integrity.mjs'
const image=color=>{const p=new PNG({width:2,height:2});for(let i=0;i<p.data.length;i+=4)p.data.set(color,i);return {mime:'image/png',base64:PNG.sync.write(p).toString('base64')}}
async function fixture(){const d=await PDFDocument.create(),p=d.addPage([500,600]);p.drawText('Original',{x:300,y:560});for(const [i,c]of [[255,0,0,255],[0,255,0,255],[0,0,255,255],[255,255,0,255],[255,0,255,255]].entries())p.drawImage(await d.embedPng(Buffer.from(image(c).base64,'base64')),{x:40,y:500-i*90,width:30,height:20});return Buffer.from(await d.save())}
const execute=(bytes,operation,action='draftInserts')=>createPdfDraftInsertsJob(action).execute(bytes,JSON.stringify({version:1,action,operation}))

test('unified PDF snapshot preserves existing image pixel edits through page rotation and reorder',async()=>{
 const doc=await PDFDocument.load(await fixture());doc.addPage([500,600]).drawText('Second page')
 const original=Buffer.from(await doc.save()),copy=Buffer.from(original)
 const snapshot={fileId:'11111111-1111-4111-8111-111111111111',baseRevision:'22222222-2222-4222-8222-222222222222',generation:1,markups:[],notes:[],textInserts:[{id:'T1',input:{pageIndex:0,origin:[200,300],text:'Combined draft',fontSize:14,color:[0,0,0]}}],imageEdits:[],savedImageEdits:[{op:'set_image_opacity',page:1,image_number:1,opacity:.8},{op:'delete_image',page:1,image_number:2}],formEdits:{},formFields:[],rotations:{0:90},deleted:[],order:[1,0],metadata:{title:'Combined image'}}
 const run=s=>createPdfApplyOpsJob().execute(original,JSON.stringify({version:1,action:'applyOps',snapshot:s}))
 const {bytes}=await run(snapshot),after=await PDFDocument.load(bytes),leaves=await readPdfLeafObjects(bytes)
 assert.equal(after.getPage(1).getRotation().angle,90);assert.equal(after.getTitle(),'Combined image')
 assert.ok(leaves.some(o=>o.page===0&&o.text==='Second page'));assert.ok(leaves.some(o=>o.page===1&&o.text==='Combined draft'))
 const images=leaves.filter(o=>o.page===1&&o.type===3);assert.equal(images.length,4)
 const red=images.find(o=>o.bounds[1]===500),blue=images.find(o=>o.bounds[1]===320)
 assert.ok(red);assert.ok(blue);assert.equal((await readImageSource(bytes,1,red.bounds)).bgra[3],204)
 assert.deepEqual([...(await readImageSource(bytes,1,blue.bounds)).bgra.subarray(0,4)],[255,0,0,255])
 await assert.rejects(run({...snapshot,savedImageEdits:[snapshot.savedImageEdits[0],snapshot.savedImageEdits[0]]}),{code:'INVALID_PDF_APPLY_SNAPSHOT'})
 assert.deepEqual(original,copy)
})

test('existing drafts bind original targets through deletion and changed sorting, before text/image insertion',async()=>{
 const source=await fixture(),snapshot=Buffer.from(source),operation={texts:[{page:1,text:'Pending text',x:220,y:150}],images:[{page:1,image:image([20,80,160,255]),x:300,y:300,width:20}],imageEdits:[{op:'delete_image',page:1,image_number:1},{op:'transform_image',page:1,image_number:2,x:150,y:450},{op:'replace_image',page:1,image_number:3,image:image([0,255,255,255])},{op:'set_image_opacity',page:1,image_number:4,opacity:.8}]}
 const preview=JSON.parse((await execute(source,operation,'draftInsertsQuery')).bytes);assert.deepEqual(preview.pages.map(p=>p.page),[1]);assert.ok(PNG.sync.read(Buffer.from(preview.pages[0].png,'base64')).width>0)
 const result=await execute(source,operation),objects=await readPdfLeafObjects(result.bytes),entries=(await catalog(result.bytes)).entries
 assert.equal(entries.length,5);assert.ok(objects.some(o=>o.text==='Pending text'));assert.ok(objects.some(o=>o.text==='Original'))
 const read=async(x,y)=>{const e=entries.find(e=>Math.abs(e.image.x-x)<.1&&Math.abs(e.image.y-y)<.1);assert.ok(e,JSON.stringify(entries.map(e=>e.image)));return readImageSource(result.bytes,0,e.ref.rect)}
 assert.deepEqual([...(await read(150,450)).bgra.subarray(0,4)],[0,255,0,255]);assert.deepEqual([...(await read(40,260)).bgra.subarray(0,4)],[255,255,0,255]);assert.equal((await read(40,350)).bgra[3],204);assert.deepEqual([...(await read(40,440)).bgra.subarray(0,4)],[255,0,255,255])
 assert.deepEqual(source,snapshot)
})

test('compatibility draft previews and saves preserve forms through a batch of image operations',async()=>{
 const doc=await PDFDocument.load(await fixture()),field=doc.getForm().createTextField('Status')
 field.setText('Ready');field.addToPage(doc.getPage(0),{x:250,y:400,width:100,height:30})
 const original=Buffer.from(await doc.save())
 const operation={texts:[],images:[],imageEdits:[
  {op:'set_image_opacity',page:1,image_number:1,opacity:.5},
  {op:'transform_image',page:1,image_number:2,x:120,y:170},
  {op:'rotate_image',page:1,image_number:3,direction:'cw'},
  {op:'delete_image',page:1,image_number:4},
  {op:'replace_image',page:1,image_number:5,image:image([0,255,255,255])},
 ]}
 const preview=JSON.parse((await execute(original,operation,'draftInsertsQuery')).bytes)
 assert.equal(preview.pages[0].page,1)
 const {bytes}=await execute(original,operation)
 const listed=(await catalog(bytes)).entries.map(entry=>entry.image)
 assert.equal(listed.length,4)
 assert.ok(listed.some(entry=>entry.x===120&&entry.y===170))
 assert.ok(listed.some(entry=>entry.x===45&&entry.y===255&&entry.width===20&&entry.height===30))
 assert.equal((await readImageSource(bytes,0,[40,500,70,520])).bgra[3],128)
 assert.deepEqual([...(await readImageSource(bytes,0,[40,140,70,160])).bgra.subarray(0,4)],[255,255,0,255])
 assert.equal(pdfInsertFormState(await PDFDocument.load(bytes)),pdfInsertFormState(await PDFDocument.load(original)))
})

test('existing-only and delete-only raster previews retain stamps and reject duplicate or ambiguous original targets',async()=>{
 const original=await fixture(),stamp=async(bytes,text)=>(await createPdfStampsJob().execute(bytes,JSON.stringify({version:1,action:'stamps',operation:{op:'set_watermark',text,angle:0,size:.04}}))).bytes,source=await stamp(original,'Managed'),operation={texts:[],images:[],imageEdits:[{op:'delete_image',page:1,image_number:1}]}
 const preview=JSON.parse((await execute(source,operation,'draftInsertsQuery')).bytes);assert.equal(preview.pages.length,1)
 const saved=await execute(source,operation),removed=await stamp(saved.bytes,'');assert.equal((await catalog(removed)).entries.length,4);assert.ok(!(await readPdfLeafObjects(removed)).some(o=>o.text.includes('Managed')))
 assert.throws(()=>validatePdfDraftInserts({...operation,imageEdits:[operation.imageEdits[0],{op:'rotate_image',page:1,image_number:1}]}),{code:'INVALID_PDF_DRAFT_INSERTS'})
 assert.throws(()=>validatePdfDraftInserts({...operation,imageEdits:Array(21).fill(operation.imageEdits[0])}),{code:'INVALID_PDF_DRAFT_INSERTS'})
 await assert.rejects(execute(original,{texts:[],images:[],imageEdits:[{op:'transform_image',page:1,image_number:1,x:40,y:170},{op:'delete_image',page:1,image_number:2}]}),{code:'PDF_IMAGE_TARGET_AMBIGUOUS'})
 const abort=new AbortController();abort.abort();await assert.rejects(createPdfDraftInsertsJob('draftInserts').execute(original,JSON.stringify({version:1,action:'draftInserts',operation}),abort.signal),{code:'ABORTED'})
})

test('draft routes accept bounded existing operations with the same query and single-upload protocol',async t=>{
 const {default:Fastify}=await import('fastify'),{registerPdfRoutes}=await import('../server/src/modules/pdf/routes.ts'),{randomUUID}=await import('node:crypto'),app=Fastify({ajv:{customOptions:{removeAdditional:false}}}),received=[]
 t.after(()=>app.close())
 registerPdfRoutes(app,{async queryDraftInserts(_token,_id,input){received.push(input);return {revision:input.revision,pages:[]}},async stageDraftInserts(_token,_id,input){received.push(input);return {uploadId:'only-one'}}},{async authenticate(){}},{originCheck(){},requireSession(){}})
 const fileId=randomUUID(),revision=randomUUID(),editorId=randomUUID(),operation={texts:[],images:[],imageEdits:[{op:'delete_image',page:1,image_number:1},{op:'replace_image',page:2,image_number:2,image:image([10,20,30,255])},{op:'crop_image',page:1,image_number:3,left:.2}]}
 const {SESSION_COOKIE}=await import('../server/src/modules/auth/csrf.ts')
 const headers={cookie:SESSION_COOKIE+'='+'a'.repeat(43)}
 const query=await app.inject({method:'POST',headers,url:`/api/v1/files/${fileId}/pdf/draft-inserts/query`,payload:{revision,operation}});assert.equal(query.statusCode,200,query.body);assert.deepEqual(received[0].operation,operation)
 const save=await app.inject({method:'POST',headers,url:`/api/v1/files/${fileId}/pdf/draft-inserts/uploads`,payload:{baseRevision:revision,editorId,leaseEpoch:1,operation}});assert.equal(save.statusCode,200,save.body);assert.deepEqual(received[1].operation,operation)
 for(const imageEdits of [Array(21).fill(operation.imageEdits[0]),[{op:'delete_image',page:1,image_number:1,extra:true}],[{op:'set_image_opacity',page:1,image_number:1,opacity:2}]]){const invalid=await app.inject({method:'POST',headers,url:`/api/v1/files/${fileId}/pdf/draft-inserts/query`,payload:{revision,operation:{...operation,imageEdits}}});assert.equal(invalid.statusCode,400,invalid.body)}
 assert.equal(received.length,2)
})

test('existing draft validator rejects sparse/getter/unknown inputs and counts replacement bytes with insertions',()=>{
 for(const imageEdits of [Array(1),[{get op(){assert.fail('getter evaluated')}}],[{op:'delete_image',page:1,image_number:1,extra:1}],undefined])assert.throws(()=>validatePdfDraftInserts({texts:[],images:[],imageEdits}))
 const large={mime:'image/png',base64:Buffer.alloc(5*1024*1024).toString('base64')}
 assert.throws(()=>validatePdfDraftInserts({texts:[],images:Array(4).fill({page:1,image:large}),imageEdits:[{op:'replace_image',page:1,image_number:1,image:large}]}),{code:'PDF_IMAGE_CONTENT_LIMIT'})
})
