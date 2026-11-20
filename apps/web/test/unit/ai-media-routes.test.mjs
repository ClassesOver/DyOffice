import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import {registerAiMediaRoutes} from '../../server/src/modules/ai-tools/media-routes.ts'

test('configured media tools require an authenticated CSRF-protected session and route validated actions',async t=>{
 const app=Fastify(),calls=[];t.after(()=>app.close())
 registerAiMediaRoutes(app,{sessions:{authenticate:async token=>{assert.equal(token,'a'.repeat(43));return {roles:['personal']}}},csrf:{requireSession(request,token){assert.equal(token,'a'.repeat(43));if(request.headers['x-csrf-token']!=='proof')throw Object.assign(Error('csrf'),{statusCode:403})}},service:{generateImage:async(token,input)=>{calls.push({token,input});return {url:'data:image/png;base64,AQ=='}},analyzeMedia:async(token,input)=>{calls.push({token,input});return {text:'A scene.'}},fetchImage:async(token,url)=>{calls.push({token,url});return {base64:'iVBORw==',mime:'image/png'}}}})
 const headers={cookie:'__Host-dyoffice-session='+'a'.repeat(43),'x-csrf-token':'proof','content-type':'application/json'}
 const generated=await app.inject({method:'POST',url:'/api/v1/ai/media',headers,payload:{action:'generate_image',prompt:'Draw a desk'}})
 assert.equal(generated.statusCode,200);assert.deepEqual(generated.json(),{url:'data:image/png;base64,AQ=='})
 const analyzed=await app.inject({method:'POST',url:'/api/v1/ai/media',headers,payload:{action:'analyze_media',mediaUrls:['data:image/png;base64,AQ=='],requirements:'Describe it'}})
 assert.equal(analyzed.statusCode,200);assert.deepEqual(analyzed.json(),{text:'A scene.'})
 const fetched=await app.inject({method:'POST',url:'/api/v1/ai/media',headers,payload:{action:'fetch_image',url:'https://images.example/photo.png'}})
 assert.equal(fetched.statusCode,200);assert.deepEqual(fetched.json(),{base64:'iVBORw==',mime:'image/png'})
 assert.equal((await app.inject({method:'POST',url:'/api/v1/ai/media',headers:{...headers,'x-csrf-token':'bad'},payload:{action:'generate_image',prompt:'x'}})).statusCode,403)
 assert.equal((await app.inject({method:'POST',url:'/api/v1/ai/media',headers,payload:{action:'generate_image',prompt:'x',aspectRatio:'invalid'}})).statusCode,400)
 assert.equal((await app.inject({method:'POST',url:'/api/v1/ai/media',headers:{...headers,cookie:''},payload:{action:'generate_image',prompt:'x'}})).statusCode,401)
 assert.deepEqual(calls,[{token:'a'.repeat(43),input:{prompt:'Draw a desk'}},{token:'a'.repeat(43),input:{mediaUrls:['data:image/png;base64,AQ=='],requirements:'Describe it'}},{token:'a'.repeat(43),url:'https://images.example/photo.png'}])
})

test('image fetch rejects non-HTTPS and oversized URLs before service dispatch',async t=>{
 const app=Fastify();t.after(()=>app.close())
 let calls=0
 registerAiMediaRoutes(app,{sessions:{authenticate:async()=>({roles:['personal']})},csrf:{requireSession(){}},service:{generateImage:async()=>({}),analyzeMedia:async()=>({}),fetchImage:async()=>{calls++;return null}}})
 const headers={cookie:'__Host-dyoffice-session='+'a'.repeat(43),'content-type':'application/json'}
 assert.equal((await app.inject({method:'POST',url:'/api/v1/ai/media',headers,payload:{action:'fetch_image',url:'http://images.example/a.png'}})).statusCode,400)
 assert.equal((await app.inject({method:'POST',url:'/api/v1/ai/media',headers,payload:{action:'fetch_image',url:'https://images.example/'+ 'a'.repeat(4100)}})).statusCode,400)
 assert.equal(calls,0)
})
