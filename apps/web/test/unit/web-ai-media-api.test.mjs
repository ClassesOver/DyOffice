import test from 'node:test'
import assert from 'node:assert/strict'
import {createWebAiMediaApi,createWorkbookImageApi,createDocumentImageApi} from '../../src/editors/web-ai-media-api.ts'

test('image generation, analysis and URL fetching use the authenticated same-origin media route',async()=>{
 const calls=[],api=createWebAiMediaApi(async(...args)=>{calls.push(args);return args[2].action==='generate_image'?{url:'data:image/png;base64,AQ=='}:args[2].action==='fetch_image'?{base64:'iVBORw==',mime:'image/png'}:{text:'A desk.'}})
 assert.deepEqual(await api.aiGenerateImage({prompt:'Draw a desk',aspectRatio:'16:9'}),{url:'data:image/png;base64,AQ=='})
 assert.deepEqual(await api.generateImage({prompt:'Edit this',referenceImageUrls:['data:image/png;base64,AQ=='],transparentBackground:true}),{url:'data:image/png;base64,AQ=='})
 assert.deepEqual(await api.analyzeMedia({mediaUrls:['data:image/png;base64,AQ=='],requirements:'Describe this image'}),{text:'A desk.'})
 assert.deepEqual(await api.fetchImage('https://images.example/photo.png'),{base64:'iVBORw==',mime:'image/png'})
 assert.deepEqual(calls,[
  ['/api/v1/ai/media','POST',{action:'generate_image',prompt:'Draw a desk',aspectRatio:'16:9'}],
  ['/api/v1/ai/media','POST',{action:'generate_image',prompt:'Edit this',referenceImageUrls:['data:image/png;base64,AQ=='],transparentBackground:true}],
  ['/api/v1/ai/media','POST',{action:'analyze_media',mediaUrls:['data:image/png;base64,AQ=='],requirements:'Describe this image'}],
  ['/api/v1/ai/media','POST',{action:'fetch_image',url:'https://images.example/photo.png'}],
 ])
})

test('workbook generated images can be fetched by a short editor-local reference',async()=>{
 const fetched=[]
 const api=createWorkbookImageApi({
  generateImage:async()=>({url:'data:image/png;base64,iVBORw=='}),
  fetchImage:async url=>{fetched.push(url);return null},
 })
 const generated=await api.generateImage({prompt:'Draw a desk'})
 assert.match(generated.url,/^https:\/\/generated-image\.invalid\//)
 assert.deepEqual(await api.fetchImage(generated.url),{base64:'iVBORw==',mime:'image/png'})
 assert.equal(await api.fetchImage('https://generated-image.invalid/unknown'),null)
 await api.fetchImage('https://images.example/photo.png')
 assert.deepEqual(fetched,['https://images.example/photo.png'])
 api.clear()
 assert.equal(await api.fetchImage(generated.url),null)
})

test('workbook attachment references belong to the current message and never fetch the network',async()=>{
 const image={mime:'image/png',base64:'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGMUlNQ9wcDAwAAABj8BIWwKQKcAAAAASUVORK5CYII='}
 const api=createWorkbookImageApi({generateImage:async()=>({}),fetchImage:async()=>assert.fail('Attachment references must stay in the editor')})
 const reference=()=>api.setImageAttachments([{name:'logo.png',image}]).match(/(https:\/\/attached-image\.invalid\/[\w-]+) \| "logo\.png"/)?.[1]
 const first=reference()
 assert.ok(first)
 assert.deepEqual(await api.fetchImage(first),image)
 const second=reference()
 assert.ok(second&&second!==first)
 assert.equal(await api.fetchImage(first),null)
 assert.deepEqual(await api.fetchImage(second),image)
 api.setImageAttachments([])
 assert.equal(await api.fetchImage(second),null)
})

test('workbook converts generated and downloaded WebP to PNG without changing accepted image formats',async t=>{
 const webp='UklGRkwAAABXRUJQVlA4WAoAAAAQAAAAAQAAAAAAQUxQSAMAAAAAyMgAVlA4ICIAAABwAQCdASoCAAEAAUAmJYwCdAFAAAD++8ErAkrVm52kQQAA'
 const png='iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGMUlNQ9wcDAwAAABj8BIWwKQKcAAAAASUVORK5CYII='
 const stub=(name,value)=>{
  const before=Object.getOwnPropertyDescriptor(globalThis,name)
  Object.defineProperty(globalThis,name,{value,configurable:true})
  t.after(()=>before?Object.defineProperty(globalThis,name,before):Reflect.deleteProperty(globalThis,name))
 }
 let decodes=0,closed=0
 stub('createImageBitmap',async blob=>{
  decodes++;assert.equal(blob.type,'image/webp');assert.equal(Buffer.from(await blob.arrayBuffer()).toString('base64'),webp)
  return {width:2,height:1,close(){closed++}}
 })
 stub('document',{createElement:tag=>{
  assert.equal(tag,'canvas')
  return {getContext:kind=>{assert.equal(kind,'2d');return {drawImage(){}}},toBlob(callback,mime){
   assert.equal(this.width,2);assert.equal(this.height,1);assert.equal(mime,'image/png')
   callback(new Blob([Buffer.from(png,'base64')],{type:mime}))
  }}
 }})
 let url=`data:image/webp;base64,${webp}`
 let downloaded={mime:'image/webp',base64:webp}
 const remote='https://images.example/photo.webp'
 const api=createWorkbookImageApi({generateImage:async()=>({url}),fetchImage:async path=>{assert.equal(path,remote);return downloaded}})
 const converted=await api.generateImage({prompt:'Draw a chart'})
 assert.match(converted.url,/^https:\/\/generated-image\.invalid\//)
 assert.deepEqual(await api.fetchImage(converted.url),{mime:'image/png',base64:png})
 assert.deepEqual(await api.fetchImage(remote),{mime:'image/png',base64:png})
 for(const mime of ['image/png','image/jpeg','image/gif']){
  url=`data:${mime};base64,AQ==`
  const unchanged=await api.generateImage({prompt:'Draw a chart'})
  assert.deepEqual(await api.fetchImage(unchanged.url),{mime,base64:'AQ=='})
 }
 url='data:image/webp;base64,AQ=='
 const malformed=await api.generateImage({prompt:'Draw a chart'})
 assert.equal(malformed.url,undefined)
 assert.match(malformed.error,/WebP/)
 downloaded={mime:'image/webp',base64:'AQ=='}
 assert.equal(await api.fetchImage(remote),null)
 downloaded={mime:'image/jpeg',base64:'AQ=='}
 assert.deepEqual(await api.fetchImage(remote),downloaded)
 assert.equal(decodes,2);assert.equal(closed,2)
})

test('document generated image references stay local, bounded and cannot survive disposal or cancellation',async()=>{
 let release
 const calls=[],api=createDocumentImageApi({generateImage:async(_input,signal)=>{calls.push(signal);return {url:'data:image/png;base64,AQ==' }},fetchImage:async()=>assert.fail('Local references must not leave the editor')})
 const urls=[]
 for(let i=0;i<5;i++)urls.push((await api.generateImage({prompt:'Image '+i})).url)
 assert.equal(await api.fetchImage(urls[0]),null)
 assert.deepEqual(await api.fetchImage(urls[4]),{base64:'AQ==',mime:'image/png'})
 const controller=new AbortController();controller.abort()
 await assert.rejects(api.generateImage({prompt:'Canceled'},controller.signal),{name:'AbortError'});assert.equal(calls.length,5)
 api.dispose();assert.equal(await api.fetchImage(urls[4]),null);await assert.rejects(api.generateImage({prompt:'Closed'}),/session closed/)
 const delayed=createDocumentImageApi({generateImage:()=>new Promise(resolve=>release=resolve),fetchImage:async()=>null})
 const pending=delayed.generateImage({prompt:'Close during generation'});delayed.dispose();release({url:'data:image/png;base64,AQ=='})
 await assert.rejects(pending,/session closed/)
 const fetching=createDocumentImageApi({generateImage:async()=>({}),fetchImage:()=>new Promise(resolve=>release=resolve)})
 const fetched=fetching.fetchImage('https://images.example/delayed.png');fetching.dispose();release({base64:'AQ==',mime:'image/png'})
 assert.equal(await fetched,null)
})
