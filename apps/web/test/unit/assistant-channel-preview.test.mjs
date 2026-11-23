import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import {registerAssistantChannelRoutes} from '../../server/src/modules/assistant-channel/routes.ts'
import {backgroundDocumentBytes} from '../helpers/background-documents.mjs'

const id='10000000-0000-4000-8000-000000000001'
const fileId='10000000-0000-4000-8000-000000000002'
const revision='10000000-0000-4000-8000-000000000003'
const updated='10000000-0000-4000-8000-000000000004'
const url='/api/v1/assistant-channels/members/'+id+'/preview'
const headers={authorization:'Bearer active-member'}

test('channel preview extracts only the authorized saved revision and skips unchanged bytes',async t=>{
 const app=Fastify()
 t.after(()=>app.close())
 let reads=0,allowed=true,changeDuringRead=false,current=revision
 const bytes=await backgroundDocumentBytes('docx')
 const service={async memberPreview(token,memberId){
  assert.equal(token,'active-member');assert.equal(memberId,id)
  if(!allowed)throw Object.assign(Error('unavailable'),{statusCode:403})
  return {fileId,name:'Budget.docx',format:'docx',revision:current,reference:{key:current,sha256:'test',size:bytes.length}}
 }}
 registerAssistantChannelRoutes(app,service,{},undefined,{async readVerified(reference){
  assert.equal(reference.key,current)
  reads++
  if(changeDuringRead)current=updated
  return bytes
 }})
 const first=await app.inject({url,headers})
 assert.equal(first.statusCode,200,first.body)
 assert.equal(first.headers['cache-control'],'private, no-store')
 assert.equal(first.json().revision,revision)
 assert.match(first.json().text,/Background budget: 42 CNY/)
 assert.equal(first.json().reference,undefined)
 const same=await app.inject({url:url+'?after='+revision,headers})
 assert.equal(same.statusCode,200)
 assert.equal(same.json().text,undefined)
 assert.equal(reads,1)
 assert.equal((await app.inject({url})).statusCode,401)
 allowed=false
 assert.equal((await app.inject({url,headers})).statusCode,403)
 assert.equal(reads,1)
 allowed=true
 changeDuringRead=true
 assert.equal((await app.inject({url,headers})).statusCode,409)
 changeDuringRead=false
 const latest=await app.inject({url:url+'?after='+revision,headers})
 assert.equal(latest.statusCode,200)
 assert.equal(latest.json().revision,updated)
 assert.match(latest.json().text,/Background budget/)
})
