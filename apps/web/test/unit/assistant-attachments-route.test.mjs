import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import {registerAssistantAttachmentRoutes} from '../../server/src/modules/providers/attachments.ts'

test('attachment parser is authenticated, bounded, and returns GenOffice extracted text',async t=>{
 const app=Fastify();t.after(()=>app.close())
 registerAssistantAttachmentRoutes(app,{sessions:{authenticate:async token=>assert.equal(token,'a'.repeat(43))},csrf:{originCheck(){},requireSession(request,token){assert.equal(token,'a'.repeat(43));assert.equal(request.headers['x-csrf-token'],'proof')}}})
 const headers={cookie:'__Host-dyoffice-session='+'a'.repeat(43),'x-csrf-token':'proof','content-type':'application/octet-stream'}
 const response=await app.inject({method:'POST',url:'/api/v1/ai/attachments/parse?name=notes.txt',headers,payload:'hello GenOffice'})
 assert.equal(response.statusCode,200)
 assert.deepEqual(response.json(),{ok:true,kind:'text',text:'hello GenOffice',totalChars:15,truncated:false})
 assert.equal((await app.inject({method:'POST',url:'/api/v1/ai/attachments/parse?name=bad.exe',headers,payload:'x'})).statusCode,400)
 assert.equal((await app.inject({method:'POST',url:'/api/v1/ai/attachments/parse?name=notes.txt',headers:{...headers,cookie:''},payload:'x'})).statusCode,401)
 const large=await app.inject({method:'POST',url:'/api/v1/ai/attachments/parse?name=large.txt',headers,payload:'x'.repeat(1_000_001)})
 assert.equal(large.statusCode,200);assert.equal(large.json().truncated,true);assert.equal(large.json().text.length,1_000_000)
})
