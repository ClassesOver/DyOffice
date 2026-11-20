import test from 'node:test'
import assert from 'node:assert/strict'
import {createSecretBox} from '../../server/src/modules/admin/secrets.ts'
import {createAiMediaService} from '../../server/src/modules/ai-tools/media-service.ts'

const keyring={activeKeyId:'k1',keys:{k1:Buffer.alloc(32,9)}}
const deploymentId='11111111-1111-4111-8111-111111111111'
const userId='22222222-2222-4222-8222-222222222222'
const sessionId='33333333-3333-4333-8333-333333333333'
const token='a'.repeat(43)

function fixture(config,media=[{bytes:new Uint8Array([1,2,3]),mime:'image/png'}]){
 const calls=[],principal={deploymentId,userId,sessionId,roles:['personal']}
 const transactions={sessionIdleMs:3600000,async withPrincipalTransaction(credential,work){assert.deepEqual(credential,{kind:'session',token});return work({async query(sql,params){calls.push({sql,params});return {rows:[{config}]}}},principal)}}
 return {calls,transactions,media}
}

test('generates an image with the server-decrypted global provider key and returns editor-ready image data',async()=>{
 const box=createSecretBox(keyring),envelope=box.seal('media-secret',{deploymentId,configId:'image-1',providerId:'openai',kind:'image_generation'})
 const {calls,transactions}=fixture({revision:4,id:'image-1',kind:'image_generation',providerId:'openai',model:'gpt-image-2',baseUrl:'https://api.example/v1',envelope})
 const invoked=[]
 const service=createAiMediaService({transactions,keyring,media:{loadMedia:async refs=>refs.map(()=>({bytes:new Uint8Array([7]),mime:'image/png'})),generate:async(provider,config,input)=>{invoked.push({provider,config,input});return {bytes:new Uint8Array([137,80,78,71]),mime:'image/png'}},analyze:assert.fail}})
 const result=await service.generateImage(token,{prompt:'A blue office desk',aspectRatio:'16:9',referenceImageUrls:['data:image/png;base64,AQ==']})
 assert.equal(invoked[0].provider,'openai')
 assert.deepEqual(invoked[0].config,{apiKey:'media-secret',baseUrl:'https://api.example/v1',imageModel:'gpt-image-2',analysisModel:''})
 assert.equal(invoked[0].input.references[0].mime,'image/png')
 assert.deepEqual(result,{url:'data:image/png;base64,iVBORw=='})
 assert.doesNotMatch(JSON.stringify(result),/media-secret/)
 assert.ok(calls.some(call=>call.sql.includes('global_ai_tool_provider')&&call.params[0]==='image_generation'))
})

test('selects video analysis only for video or audio media and refuses an unconfigured capability',async()=>{
 const box=createSecretBox(keyring),envelope=box.seal('analysis-secret',{deploymentId,configId:'video-1',providerId:'gemini',kind:'video_analysis'})
 const {transactions}=fixture({revision:5,id:'video-1',kind:'video_analysis',providerId:'gemini',model:'gemini-3.8-flash',baseUrl:'https://api.example',envelope},[{bytes:new Uint8Array([1]),mime:'video/mp4'}])
 const invoked=[]
 const service=createAiMediaService({transactions,keyring,media:{loadMedia:async()=>[{bytes:new Uint8Array([1]),mime:'video/mp4'}],analyze:async(provider,config,input)=>{invoked.push({provider,config,input});return 'A short clip.'},generate:assert.fail}})
 assert.deepEqual(await service.analyzeMedia(token,{mediaUrls:['https://media.example/clip.mp4'],requirements:'Summarize'}),{text:'A short clip.'})
 assert.equal(invoked[0].provider,'gemini')
 assert.equal(invoked[0].config.apiKey,'analysis-secret')
 assert.equal(invoked[0].input.media[0].mime,'video/mp4')
 const missing=createAiMediaService({transactions:{...transactions,withPrincipalTransaction:async(_credential,work)=>work({query:async()=>({rows:[{config:null}]})},{deploymentId,userId,sessionId,roles:['personal']})},keyring,media:{loadMedia:async()=>[{bytes:new Uint8Array([1]),mime:'video/mp4'}],analyze:assert.fail,generate:assert.fail}})
 await assert.rejects(missing.analyzeMedia(token,{mediaUrls:['https://media.example/clip.mp4'],requirements:'Summarize'}),/unavailable/i)
})

test('rejects local paths, non-image generation references and malformed input before provider dispatch',async()=>{
 const {transactions}=fixture(null)
 let loaded=false,dispatched=false
 const service=createAiMediaService({transactions,keyring,media:{loadMedia:async()=>{loaded=true;return []},generate:async()=>{dispatched=true;return {bytes:new Uint8Array(),mime:'image/png'}},analyze:assert.fail}})
 await assert.rejects(service.generateImage(token,{prompt:'draw',referenceImageUrls:['/etc/passwd']}),/unavailable/i)
 assert.equal(loaded,false)
 assert.equal(dispatched,false)
 await assert.rejects(service.generateImage(token,{prompt:' '}),/unavailable/i)
})

test('fetches one HTTPS image through the bounded media loader and rejects non-images',async()=>{
 const {transactions}=fixture(null)
 const service=createAiMediaService({transactions,keyring,media:{loadMedia:async refs=>{
  assert.deepEqual(refs,['https://images.example/picture.png'])
  return [{bytes:new Uint8Array([137,80,78,71]),mime:'image/png'}]
 },generate:assert.fail,analyze:assert.fail}})
 assert.deepEqual(await service.fetchImage(token,'https://images.example/picture.png'),{base64:'iVBORw==',mime:'image/png'})
 await assert.rejects(service.fetchImage(token,'http://images.example/picture.png'),/unavailable/i)
 const nonImage=createAiMediaService({transactions,keyring,media:{loadMedia:async()=>[{bytes:new Uint8Array([1]),mime:'text/html'}],generate:assert.fail,analyze:assert.fail}})
 await assert.rejects(nonImage.fetchImage(token,'https://images.example/picture.png'),/unavailable/i)
})

test('fetches bounded WebP bytes for PDF normalization without allowing other media or changing HTTPS policy',async()=>{
 const {transactions}=fixture(null),bytes=new Uint8Array([82,73,70,70,0,0,0,0,87,69,66,80])
 const service=createAiMediaService({transactions,keyring,media:{loadMedia:async refs=>{assert.deepEqual(refs,['https://images.example/picture.webp']);return [{bytes,mime:'image/webp'}]},generate:assert.fail,analyze:assert.fail}})
 assert.deepEqual(await service.fetchImage(token,'https://images.example/picture.webp'),{base64:Buffer.from(bytes).toString('base64'),mime:'image/webp'})
 await assert.rejects(service.fetchImage(token,'http://images.example/picture.webp'),/unavailable/i)
 const tooLarge=createAiMediaService({transactions,keyring,media:{loadMedia:async()=>[{bytes:new Uint8Array(5*1024*1024+1),mime:'image/webp'}],generate:assert.fail,analyze:assert.fail}})
 await assert.rejects(tooLarge.fetchImage(token,'https://images.example/picture.webp'),/unavailable/i)
})
