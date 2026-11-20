import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID,createHash} from 'node:crypto'
import {PDFDocument,StandardFonts} from 'pdf-lib'
import Fastify from 'fastify'
import {createPdfService} from '../../server/src/modules/pdf/service.ts'
import {registerPdfRoutes} from '../../server/src/modules/pdf/routes.ts'

test('annotation planning reads authorized revision geometry without uploads and rejects stale results',async()=>{
 const doc=await PDFDocument.create(),font=await doc.embedFont(StandardFonts.Helvetica)
 doc.addPage([300,200]).drawText('Original report',{x:20,y:100,size:12,font})
 const bytes=Buffer.from(await doc.save()),original=Buffer.from(bytes),sha256=createHash('sha256').update(bytes).digest('hex'),revision=randomUUID(),fileId=randomUUID()
 let opens=0,changed=false
 const files={async openFile(token,id){assert.equal(token,'session');assert.equal(id,fileId);opens++;return {format:'pdf',file:{revision:changed&&opens%2===0?randomUUID():revision,sha256}}},async download(){return {format:'pdf',bytes}}}
 // Deliberately no lease, stage, upload or commit methods: queries must not write.
 const service=createPdfService({files,leases:{},revisions:{}}),input={revision,operations:[{page:1,text:'Original',type:'highlight'},{page:1,text:'report',type:'note',contents:'Review'}]}
 assert.equal(typeof service.queryAnnotations,'function')
 const result=await service.queryAnnotations('session',fileId,input)
 assert.equal(result.revision,revision);assert.equal(result.markups.length,1);assert.equal(result.notes.length,1)
 assert.equal(result.markups[0].pageIndex,0);assert.equal(result.markups[0].quads[0][0],20)
 assert.equal(result.notes[0].contents,'Review');assert.deepEqual(bytes,original)
 await assert.rejects(service.queryAnnotations('session',fileId,{...input,revision:randomUUID()}),e=>e.statusCode===409)
 opens=0;changed=true
 await assert.rejects(service.queryAnnotations('session',fileId,input),e=>e.statusCode===409)
 await assert.rejects(service.queryAnnotations('session',fileId,{...input,operations:[{...input.operations[0],quads:[]}]}),e=>e.statusCode===400)
})

test('annotation query route enforces session CSRF and disallows client geometry or processor selection',async t=>{
 const app=Fastify({ajv:{customOptions:{removeAdditional:false,coerceTypes:false,useDefaults:false}}});t.after(()=>app.close())
 const token='a'.repeat(43),fileId=randomUUID(),revision=randomUUID(),calls=[]
 const forbidden=()=>Object.assign(Error('Forbidden'),{statusCode:403})
 registerPdfRoutes(app,{queryAnnotations:async(...args)=>{calls.push(args);return {revision,markups:[],notes:[]}}},{authenticate:async value=>{if(value!==token)throw forbidden()}},{originCheck(){},requireSession(request,value){if(value!==token||request.headers['x-csrf-token']!==token)throw forbidden()}})
 const payload={revision,operations:[{page:1,text:'Original',type:'highlight'}]},url=`/api/v1/files/${fileId}/pdf/annotations/query`,headers={cookie:`__Host-dyoffice-session=${token}`,'x-csrf-token':token}
 assert.equal((await app.inject({method:'POST',url,payload})).statusCode,403)
 assert.equal((await app.inject({method:'POST',url,headers:{cookie:headers.cookie},payload})).statusCode,403)
 const response=await app.inject({method:'POST',url,headers,payload});assert.equal(response.statusCode,200,response.body)
 assert.deepEqual(calls[0].slice(0,3),[token,fileId,payload]);assert.ok(calls[0][3] instanceof AbortSignal)
 for(const patch of [{path:'/tmp/source.pdf'},{action:'applyOps'},{operations:[{...payload.operations[0],quads:[]}]},{operations:[]}])assert.equal((await app.inject({method:'POST',url,headers,payload:{...payload,...patch}})).statusCode,400)
 assert.equal(calls.length,1)
})
