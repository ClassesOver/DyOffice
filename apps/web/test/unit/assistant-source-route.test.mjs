import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import {registerAssistantSourceCatalog} from '../../server/src/modules/sources/assistant-catalog.ts'

test('source catalog route maps only list, never accepts identity or query arguments',async t=>{
 const app=Fastify({ajv:{customOptions:{removeAdditional:false}}}), calls=[]
 t.after(()=>app.close())
 registerAssistantSourceCatalog(app,{
  sessions:{authenticate:async token=>{assert.equal(token,'a'.repeat(43))}},
  csrf:{requireSession:(_request,token)=>assert.equal(token,'a'.repeat(43))},
  sources:{listPublishedMetadata:async(token,input)=>{calls.push({token,input});return {items:[],nextCursor:null}}},
 })
 const request={method:'POST',url:'/api/v1/ai/sources/list',headers:{cookie:'__Host-dyoffice-session=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'}}
 assert.equal((await app.inject({...request,payload:{after:'previous'}})).statusCode,200)
 assert.deepEqual(calls,[{token:'a'.repeat(43),input:{after:'previous'}}])
 for(const payload of [{ownerId:'other'},{sql:'SELECT 1'},{after:'../x'},{name:'sources.query'}])assert.equal((await app.inject({...request,payload})).statusCode,400)
 assert.equal(calls.length,1)
})
