import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import {registerAiSearchRoutes} from '../../server/src/modules/ai-tools/routes.ts'

test('configured web search requires a session, CSRF proof and valid tool arguments',async t=>{
 const app=Fastify(),calls=[];t.after(()=>app.close())
 registerAiSearchRoutes(app,{sessions:{authenticate:async token=>{assert.equal(token,'a'.repeat(43));return {roles:['personal']}}},csrf:{requireSession(request,token){assert.equal(token,'a'.repeat(43));if(request.headers['x-csrf-token']!=='proof')throw Object.assign(Error('csrf'),{statusCode:403})}},service:{search:async(token,input)=>{calls.push({token,input});return {results:[{title:'Result',url:'https://example.com',snippet:'Summary'}],method:'serper'}}}})
 const headers={cookie:'__Host-dyoffice-session='+'a'.repeat(43),'x-csrf-token':'proof','content-type':'application/json'}
 const response=await app.inject({method:'POST',url:'/api/v1/ai/search',headers,payload:{kind:'web_search',query:'GenOffice',maxResults:3}})
 assert.equal(response.statusCode,200)
 assert.deepEqual(response.json(),{results:[{title:'Result',url:'https://example.com',snippet:'Summary'}],method:'serper'})
 assert.deepEqual(calls,[{token:'a'.repeat(43),input:{kind:'web_search',query:'GenOffice',maxResults:3}}])
 assert.equal((await app.inject({method:'POST',url:'/api/v1/ai/search',headers:{...headers,'x-csrf-token':'bad'},payload:{kind:'web_search',query:'x',maxResults:1}})).statusCode,403)
 assert.equal((await app.inject({method:'POST',url:'/api/v1/ai/search',headers,payload:{kind:'generate_image',query:'x',maxResults:1}})).statusCode,400)
 assert.equal((await app.inject({method:'POST',url:'/api/v1/ai/search',headers:{...headers,cookie:''},payload:{kind:'web_search',query:'x',maxResults:1}})).statusCode,401)
 assert.equal(calls.length,1)
})
