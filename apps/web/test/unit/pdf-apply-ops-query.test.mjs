import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID,createHash} from 'node:crypto'
import {PDFDocument} from 'pdf-lib'
import {PNG} from 'pngjs'
import Fastify from 'fastify'
import {createPdfService} from '../../server/src/modules/pdf/service.ts'
import {registerPdfRoutes} from '../../server/src/modules/pdf/routes.ts'
const snapshot=(fileId,revision)=>({fileId,baseRevision:revision,generation:7,markups:[],notes:[],textInserts:[],imageEdits:[],formEdits:{},formFields:[],rotations:{0:90},deleted:[],order:null,metadata:{title:'Temporary'}})
async function fixture(){const d=await PDFDocument.create();d.addPage([300,400]);const bytes=Buffer.from(await d.save()),fileId=randomUUID(),revision=randomUUID(),sha256=createHash('sha256').update(bytes).digest('hex');let opens=0,downloads=0,late=''
 const files={async openFile(token,id){assert.equal(id,fileId);if(token!=='allowed')throw Object.assign(Error('Not Found'),{statusCode:404});opens++;if(opens===2&&late==='revoked')throw Object.assign(Error('Not Found'),{statusCode:404});return {format:'pdf',file:{revision:opens===2&&late==='revision'?randomUUID():revision,sha256:opens===2&&late==='hash'?'f'.repeat(64):sha256}}},async download(){downloads++;return {format:'pdf',bytes}}}
 return {bytes,fileId,revision,files,setLate:v=>{opens=0;late=v},downloads:()=>downloads}
}
test('preview service has no lease upload or revision writer and returns bound generation with temporary PDF',async()=>{
 const f=await fixture(),service=createPdfService({files:f.files,leases:{},revisions:{}}),input={revision:f.revision,snapshot:snapshot(f.fileId,f.revision)}
 assert.equal(typeof service.queryApplyOps,'function');const result=await service.queryApplyOps('allowed',f.fileId,input)
 assert.equal(result.revision,f.revision);assert.equal(result.generation,7);assert.ok(result.pdf.length<=Math.ceil(64*1024*1024/3)*4)
 const bytes=Buffer.from(result.pdf,'base64');assert.equal(bytes.toString('base64'),result.pdf);const d=await PDFDocument.load(bytes);assert.equal(d.getTitle(),'Temporary');assert.equal(d.getPage(0).getRotation().angle,90);assert.equal((await PDFDocument.load(f.bytes)).getPage(0).getRotation().angle,0)
})
test('preview service rejects authority mismatch unauthorized stale head hash and revoked access',async()=>{
 const f=await fixture(),service=createPdfService({files:f.files,leases:{},revisions:{}}),input={revision:f.revision,snapshot:snapshot(f.fileId,f.revision)}
 for(const patch of [{snapshot:{...input.snapshot,fileId:randomUUID()}},{snapshot:{...input.snapshot,baseRevision:randomUUID()}},{snapshot:{...input.snapshot,path:'/tmp/a'}}])await assert.rejects(service.queryApplyOps('allowed',f.fileId,{...input,...patch}),e=>e.statusCode===400)
 assert.equal(f.downloads(),0);await assert.rejects(service.queryApplyOps('blocked',f.fileId,input),e=>e.statusCode===404)
 await assert.rejects(service.queryApplyOps('allowed',f.fileId,{revision:randomUUID(),snapshot:{...input.snapshot,baseRevision:randomUUID()}}),e=>e.statusCode===400||e.statusCode===409)
 for(const mode of ['revision','hash','revoked']){f.setLate(mode);await assert.rejects(service.queryApplyOps('allowed',f.fileId,input),e=>e.statusCode===(mode==='revoked'?404:409))}
 const c=new AbortController();c.abort();await assert.rejects(service.queryApplyOps('allowed',f.fileId,input,c.signal),{name:'AbortError'})
})
test('preview route requires session CSRF exact revision snapshot schema and exposes no stage controls',async t=>{
 const app=Fastify({ajv:{customOptions:{removeAdditional:false,coerceTypes:false,useDefaults:false}}});t.after(()=>app.close())
 const token='a'.repeat(43),fileId=randomUUID(),revision=randomUUID(),calls=[],forbidden=()=>Object.assign(Error('Forbidden'),{statusCode:403})
 registerPdfRoutes(app,{queryApplyOps:async(...args)=>{calls.push(args);return {revision,generation:7,pdf:'JVBERi0='}}},{authenticate:async value=>{if(value!==token)throw forbidden()}},{originCheck(){},requireSession(request,value){if(value!==token||request.headers['x-csrf-token']!==token)throw forbidden()}})
 const payload={revision,snapshot:snapshot(fileId,revision)},url=`/api/v1/files/${fileId}/pdf/apply-ops/query`,headers={cookie:`__Host-dyoffice-session=${token}`,'x-csrf-token':token}
 assert.equal((await app.inject({method:'POST',url,payload})).statusCode,403);assert.equal((await app.inject({method:'POST',url,headers:{cookie:headers.cookie},payload})).statusCode,403)
 const reply=await app.inject({method:'POST',url,headers,payload});assert.equal(reply.statusCode,200,reply.body);assert.deepEqual(calls[0].slice(0,3),[token,fileId,payload]);assert.ok(calls[0][3] instanceof AbortSignal)
 for(const patch of [{path:'/tmp/x'},{action:'applyOps'},{editorId:fileId},{leaseEpoch:1},{revision:'bad'},{snapshot:{...payload.snapshot,path:'/tmp/x'}},{snapshot:{...payload.snapshot,generation:-1}}])assert.equal((await app.inject({method:'POST',url,headers,payload:{...payload,...patch}})).statusCode,400)
 assert.equal(calls.length,1)
})

test('text and image query services retain native writer payloads without write services',async()=>{
 const f=await fixture(),service=createPdfService({files:f.files,leases:{},revisions:{}})
 const text=await service.queryTextInserts('allowed',f.fileId,{revision:f.revision,operations:[{page:1,text:'Native payload',x:50,y:50,font_size:12}]})
 assert.equal(text.revision,f.revision);assert.equal(text.blocks.length,1);assert.equal(text.inserts.length,1)
 assert.equal(text.inserts[0].pageIndex,0);assert.equal(text.inserts[0].text,'Native payload');assert.equal(text.inserts[0].fontSize,12);assert.equal(text.inserts[0].rotate,0);assert.equal(text.inserts[0].origin.length,2);assert.ok(text.inserts[0].origin.every(Number.isFinite))
 const png=new PNG({width:2,height:2});png.data.fill(255);const base64=PNG.sync.write(png).toString('base64')
 const image=await service.queryImageInserts('allowed',f.fileId,{revision:f.revision,operation:{page:1,image:{mime:'image/png',base64},x:50,y:50,width:20,height:20,layer:'above_text'}})
 assert.equal(image.revision,f.revision);assert.equal(image.image.pixelWidth,2)
 assert.deepEqual(image.edit,{kind:'insertImage',pageIndex:0,rect:[50,330,70,350],rotate:0,layer:'aboveText',image:base64})
})
