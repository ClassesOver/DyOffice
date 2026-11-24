import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import {registerPdfRoutes} from '../../server/src/modules/pdf/routes.ts'

test('mixed PDF snapshot upload requires session and CSRF and exposes no caller-selected processor',async t=>{
 const app=Fastify({ajv:{customOptions:{removeAdditional:false,coerceTypes:false,useDefaults:false}}});t.after(()=>app.close())
 const token='a'.repeat(43),fileId='74ad6054-8061-44ef-b42c-ef55e5bf851d',revision='4746fb72-4380-4d28-9802-86fa3b462807',calls=[]
 const forbidden=()=>Object.assign(Error('Forbidden'),{statusCode:403})
 registerPdfRoutes(app,{stageApplyOps:async(...args)=>{calls.push(args);return {commitInput:{fileId,baseRevision:revision}}}},{authenticate:async value=>{if(value!==token)throw forbidden()}},{originCheck(){},requireSession(request,value){if(value!==token||request.headers['x-csrf-token']!==token)throw forbidden()}})
 const snapshot={fileId,baseRevision:revision,generation:1,markups:[],notes:[],textInserts:[],imageEdits:[],formEdits:{},formFields:[],rotations:{0:90},deleted:[],order:null,metadata:{title:'Mixed'}}
 snapshot.drawings=[{kind:'ink',pageIndex:0,color:[0.2,0.4,0.8],width:2,paths:[[10,20,30,40]]}]
 snapshot.outline=[{title:'Chapter',pageIndex:0}]
 snapshot.formWidgetEdits=[{widgetId:'12R',fieldName:'field',remove:true}]
 const payload={baseRevision:revision,editorId:fileId,leaseEpoch:1,idempotencyKey:'mixed-ops-save',snapshot},url=`/api/v1/files/${fileId}/pdf/apply-ops/uploads`,headers={cookie:`__Host-dyoffice-session=${token}`,'x-csrf-token':token}
 assert.equal((await app.inject({method:'POST',url,payload})).statusCode,403)
 assert.equal((await app.inject({method:'POST',url,headers:{cookie:headers.cookie},payload})).statusCode,403)
 const reply=await app.inject({method:'POST',url,headers,payload});assert.equal(reply.statusCode,200,reply.body)
 assert.deepEqual(calls[0].slice(0,3),[token,fileId,payload]);assert.ok(calls[0][3] instanceof AbortSignal)
 for(const patch of [{action:'pageOps'},{path:'/tmp/target.pdf'},{leaseEpoch:0},{baseRevision:'stale'},{snapshot:null},{snapshot:{...snapshot,path:'/tmp/source.pdf'}},{snapshot:{...snapshot,generation:-1}}])assert.equal((await app.inject({method:'POST',url,headers,payload:{...payload,...patch}})).statusCode,400)
 assert.equal(calls.length,1)
})
