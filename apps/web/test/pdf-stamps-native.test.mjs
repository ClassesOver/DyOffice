import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {PDFDocument,PDFName,degrees} from 'pdf-lib'
import {PNG} from 'pngjs'
import {createPdfStampsJob,preservePdfManagedStamps} from '../server/src/pdf/stamps-job.mjs'
import {createPdfTextInsertsJob,planPdfTextInserts} from '../server/src/pdf/text-inserts-job.mjs'
import {createPdfImageContentJob} from '../server/src/pdf/image-content-job.mjs'
import {applySaveRequest} from '../../pdf/src/main/save-pdf.ts'
import {readPdfLeafObjects} from '../../pdf/src/main/text-edit.ts'
const command=(action,values)=>JSON.stringify({version:1,action,...values})
const stamp=async(bytes,operation)=>(await createPdfStampsJob().execute(bytes,command('stamps',{operation}))).bytes
const text=async bytes=>(await readPdfLeafObjects(bytes)).filter(item=>item.type===1).map(item=>item.text).join('|')
async function fixture(){const d=await PDFDocument.create();for(const rotation of [0,90,180,270]){const p=d.addPage([500,600]);p.setCropBox(20,30,450,540);p.setRotation(degrees(rotation));p.node.set(PDFName.of('UserUnit'),d.context.obj(2));p.drawText('Keep source text',{x:50,y:220,size:14})}return Buffer.from(await d.save())}
async function pixels(t,a,b){
 const dir=await mkdtemp(join(tmpdir(),'dyoffice-stamp-native-'));t.after(()=>rm(dir,{recursive:true,force:true}))
 for(const [label,bytes]of [['before',a],['after',b]]){await writeFile(join(dir,label+'.pdf'),bytes);await promisify(execFile)('pdftoppm',['-r','36','-png',join(dir,label+'.pdf'),join(dir,label)],{timeout:15000})}
 for(let page=1;page<=4;page++){const x=PNG.sync.read(await readFile(join(dir,`before-${page}.png`))),y=PNG.sync.read(await readFile(join(dir,`after-${page}.png`)));assert.deepEqual(y.data,x.data,`page ${page} unchanged painting pixels`)}
}
test('PDFium text insertion preserves managed overlays at their native painting positions and supports replace/remove',async t=>{
 const source=await fixture(),wm=await stamp(source,{op:'set_watermark',text:'Editable draft'}),both=await stamp(wm,{op:'set_header_footer',header_left:'第{page}页',page_number:true}),operations=[1,2,3,4].map(page=>({page,text:'Inserted text',x:80,y:160}))
 const inserts=await planPdfTextInserts(both,operations),raw=await applySaveRequest(both,{formValues:[],markups:[],drawings:[],rotations:[],textInserts:inserts}),preserved=await preservePdfManagedStamps(both,raw.bytes)
 const leaves=async bytes=>(await readPdfLeafObjects(bytes)).map(item=>[item.type,item.text,item.page,item.bounds])
 assert.deepEqual(await leaves(preserved),await leaves(raw.bytes));await pixels(t,raw.bytes,preserved)
 const result=await createPdfTextInsertsJob().execute(both,command('textInserts',{operations})),replaced=await stamp(result.bytes,{op:'set_watermark',text:'Final draft'}),noWm=await stamp(replaced,{op:'set_watermark',text:''}),clean=await stamp(noWm,{op:'set_header_footer'})
 assert.doesNotMatch(await text(clean),/Editable draft|Final draft|第1页/);assert.equal((await text(clean)).match(/Inserted text/g).length,4);assert.equal((await text(clean)).match(/Keep source text/g).length,4)
 // Repeated native saves must repair the latest references, not just the first edit.
 const second=await createPdfTextInsertsJob().execute(result.bytes,command('textInserts',{operations:[{page:1,text:'Second insert',x:80,y:210}]})),removed=await stamp(second.bytes,{op:'set_watermark',text:''});assert.match(await text(removed),/Second insert/)
})
test('native image insertion preserves stamp management and image pixels after removing both stamp kinds',async()=>{
 const source=await fixture(),wm=await stamp(source,{op:'set_watermark',text:'Image draft'}),both=await stamp(wm,{op:'set_header_footer',footer_right:'End'}),picture=new PNG({width:2,height:2});picture.data.fill(255)
 const result=await createPdfImageContentJob().execute(both,command('imageContent',{operation:{op:'insert_image',page:1,image:{base64:PNG.sync.write(picture).toString('base64'),mime:'image/png'},x:70,y:70,width:40}})),noWm=await stamp(result.bytes,{op:'set_watermark',text:''}),clean=await stamp(noWm,{op:'set_header_footer'})
 assert.equal((await readPdfLeafObjects(clean)).filter(item=>item.type===3).length,1);assert.equal((await text(clean)).match(/Keep source text/g).length,4);assert.doesNotMatch(await text(clean),/Image draft|End/)
})
