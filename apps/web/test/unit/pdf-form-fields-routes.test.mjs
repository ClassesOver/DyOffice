import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import {registerPdfRoutes} from '../../server/src/modules/pdf/routes.ts'

test('PDF field creation route enforces session, CSRF and the fixed revision-bound field vocabulary',async t=>{
 const app=Fastify({ajv:{customOptions:{removeAdditional:false,coerceTypes:false,useDefaults:false}}});t.after(()=>app.close())
 const token='a'.repeat(43),fileId='74ad6054-8061-44ef-b42c-ef55e5bf851d',revision='4746fb72-4380-4d28-9802-86fa3b462807',calls=[]
 const unauthorized=()=>Object.assign(Error('Unauthorized'),{statusCode:403})
 registerPdfRoutes(app,{stageFormFields:async(...args)=>{calls.push(args);return {commitInput:{fileId,baseRevision:revision}}}},{authenticate:async value=>{if(value!==token)throw unauthorized()}},{originCheck(){},requireSession(request,value){if(value!==token||request.headers['x-csrf-token']!==token)throw unauthorized()}})
 const url=`/api/v1/files/${fileId}/pdf/form-fields/uploads`,headers={cookie:`__Host-dyoffice-session=${token}`,'x-csrf-token':token}
 const field={name:'Reviewer',kind:'text',page:1,x:40,y:80,width:180,height:24,value:'张三'},payload={baseRevision:revision,editorId:fileId,leaseEpoch:1,idempotencyKey:'create-fields',operations:[{op:'addFormField',field}]}
 assert.equal((await app.inject({method:'POST',url,payload})).statusCode,403)
 assert.equal((await app.inject({method:'POST',url,headers:{cookie:headers.cookie},payload})).statusCode,403)
 const reply=await app.inject({method:'POST',url,headers,payload});assert.equal(reply.statusCode,200,reply.body)
 assert.deepEqual(calls[0].slice(0,3),[token,fileId,payload]);assert.ok(calls[0][3] instanceof AbortSignal)
 for(const patch of [{kind:'button'},{page:0},{width:0},{height:-1},{x:'40'},{path:'/tmp/file'},{rect:[0,0,10,20]}])assert.equal((await app.inject({method:'POST',url,headers,payload:{...payload,operations:[{op:'addFormField',field:{...field,...patch}}]}})).statusCode,400)
 assert.equal((await app.inject({method:'POST',url,headers,payload:{...payload,path:'/tmp/file'}})).statusCode,400)
 assert.equal(calls.length,1)
})
