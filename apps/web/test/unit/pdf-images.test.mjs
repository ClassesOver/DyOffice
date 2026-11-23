import test from 'node:test'
import assert from 'node:assert/strict'
import {createPdfImageAccess} from '../../src/editors/pdf-images.ts'
const rows=[{page:1,image_number:1,x:10,y:20,width:100,height:50,layer:'below_text'},{page:2,image_number:1,x:0,y:0,width:50,height:50,layer:'above_text'}]
test('image numbers are bound to the listed page and revision and invalidated after edits',async()=>{
 let revision='r1',ready=true;const writes=[],requests=[]
 const access=createPdfImageAccess({fileId:'f',request:async(...args)=>{requests.push(args);return {revision,images:rows}},getRevision:()=>revision,isReady:()=>ready,write:async(...args)=>{writes.push(args);return true}})
 const operation={op:'delete_image',page:1,image_number:1},controller=new AbortController()
 assert.equal(await access.edit(operation),false)
 assert.deepEqual(await access.read(1,controller.signal),[rows[0]])
 assert.deepEqual(requests[0],['/api/v1/files/f/pdf/images/query','POST',{revision:'r1'},controller.signal])
 assert.equal(await access.edit({...operation,page:2}),false)
 assert.equal(await access.edit(operation,controller.signal),true);assert.deepEqual(writes,[[operation,controller.signal]])
 assert.equal(await access.edit(operation),false)
 await access.read();revision='r2';assert.equal(await access.edit(operation),false)
 ready=false;await assert.rejects(access.read());assert.equal(writes.length,1)
})
test('late or failed image queries never authorize edits against a changed revision',async()=>{
 let revision='r1',resolve,fail=false
 const access=createPdfImageAccess({fileId:'f',request:async()=>{if(fail)throw Error('unavailable');return new Promise(r=>{resolve=r})},getRevision:()=>revision,isReady:()=>true,write:async()=>assert.fail('stale image write')})
 const pending=access.read();revision='r2';resolve({revision:'r1',images:rows});await assert.rejects(pending)
 assert.equal(await access.edit({op:'delete_image',page:1,image_number:1}),false)
 fail=true;await assert.rejects(access.read())
 const controller=new AbortController();controller.abort();await assert.rejects(access.read(undefined,controller.signal),{name:'AbortError'})
})

test('image insertion downloads bytes once, replacement requires a current listing, and both invalidate old numbers',async()=>{
 let revision='r1';const writes=[],fetches=[],controller=new AbortController()
 const image={mime:'image/png',base64:'iVBORw0KGgo='}
 const access=createPdfImageAccess({fileId:'f',request:async()=>({revision,images:rows}),getRevision:()=>revision,isReady:()=>true,write:async()=>assert.fail('geometry write'),fetchImage:async(...args)=>{fetches.push(args);return image},writeContent:async(...args)=>{writes.push(args);return true}})
 assert.equal(await access.content({op:'replace_image',page:1,image_number:1,url:'https://images.example/a.png'}),false)
 await access.read(1)
 assert.equal(await access.content({op:'replace_image',page:1,image_number:1,url:'https://images.example/a.png'},controller.signal),true)
 assert.deepEqual(writes,[[{op:'replace_image',page:1,image_number:1,image},controller.signal]])
 assert.deepEqual(fetches,[['https://images.example/a.png',controller.signal]])
 assert.equal(await access.edit({op:'delete_image',page:1,image_number:1}),false)
 assert.equal(await access.content({op:'insert_image',page:2,url:'data:image/png;base64,iVBORw0KGgo=',anchor_text:'Caption',placement:'left',width:80}),true)
 assert.deepEqual(writes[1][0],{op:'insert_image',page:2,image,anchor_text:'Caption',placement:'left',width:80})
 assert.equal(fetches.length,1)
})

test('image content cannot bind to a new revision or bypass pending saves after an asynchronous download',async()=>{
 for(const change of ['revision','ready','abort']){
  let revision='r1',ready=true,resolve;const controller=new AbortController()
  const access=createPdfImageAccess({fileId:'f',request:async()=>({revision,images:rows}),getRevision:()=>revision,isReady:()=>ready,write:async()=>false,fetchImage:async()=>new Promise(r=>{resolve=r}),writeContent:async()=>assert.fail('stale image content')})
  await access.read()
  const pending=access.content({op:'replace_image',page:1,image_number:1,url:'https://images.example/a.png'},controller.signal)
  if(change==='revision')revision='r2';if(change==='ready')ready=false;if(change==='abort')controller.abort()
  resolve({mime:'image/png',base64:'iVBORw0KGgo='})
  if(change==='abort')await assert.rejects(pending,{name:'AbortError'});else assert.equal(await pending,false)
 }
})

test('unsupported image URLs, WebP, malformed and oversized bytes fail before preparing a PDF write',async()=>{
 const access=createPdfImageAccess({fileId:'f',request:async()=>({revision:'r1',images:rows}),getRevision:()=> 'r1',isReady:()=>true,write:async()=>false,fetchImage:async()=>assert.fail('invalid URL downloaded'),writeContent:async()=>assert.fail('invalid bytes staged')})
 for(const url of ['http://images.example/a.png','file:///tmp/image.png','data:image/webp;base64,UklGRg==','data:image/png;base64,abc','data:image/png;base64,AB==','data:image/png;base64,'+'AAAA'.repeat(1747627)] )await assert.rejects(access.content({op:'insert_image',page:1,url}))
})

test('pixel bakes need current image numbers and invalidate their snapshot after each attempted save',async()=>{
 let revision='r1',ready=true;const writes=[]
 const access=createPdfImageAccess({fileId:'f',request:async()=>({revision,images:rows}),getRevision:()=>revision,isReady:()=>ready,write:async(...args)=>{writes.push(args);return true}})
 const operations=[{op:'flip_image',page:1,image_number:1,axis:'horizontal'},{op:'set_image_opacity',page:1,image_number:1,opacity:0},{op:'crop_image',page:1,image_number:1,left:.25},{op:'remove_image_background',page:1,image_number:1}]
 for(const operation of operations){
  assert.equal(await access.edit(operation),false)
  await access.read(1);assert.equal(await access.edit({...operation,page:2}),false)
  assert.equal(await access.edit(operation),true)
  assert.equal(await access.edit(operation),false)
 }
 assert.deepEqual(writes.map(([operation])=>operation),operations)
 await access.read();revision='r2';assert.equal(await access.edit(operations[0]),false)
 await access.read();ready=false;assert.equal(await access.edit(operations[0]),false)
})

test('pending image insertion queues resolved bytes without saving while saved catalog remains readable',async()=>{
 const queued=[],info={id:'I1',page:1,x:10,y:20,width:100,height:50},controller=new AbortController()
 const access=createPdfImageAccess({fileId:'f',request:async()=>({revision:'r1',images:rows}),getRevision:()=> 'r1',isReady:()=>false,isDraftReady:()=>true,isReadable:()=>true,write:async()=>assert.fail('saved edit'),fetchImage:async()=>assert.fail('data URL download'),writeContent:async()=>assert.fail('immediate content save'),queueInsert:async(...args)=>{queued.push(args);return info}})
 assert.deepEqual(await access.insertDraft({op:'insert_image',page:1,url:'data:image/png;base64,iVBORw0KGgo=',width:100},controller.signal),info)
 assert.deepEqual(queued,[[{op:'insert_image',page:1,width:100,image:{mime:'image/png',base64:'iVBORw0KGgo='}},controller.signal]])
 assert.deepEqual(await access.read(1),[rows[0]])
 assert.equal(await access.edit({op:'delete_image',page:1,image_number:1}),false)
 assert.equal(await access.content({op:'replace_image',page:1,image_number:1,url:'https://example.com/a.png'}),false)
})

test('pending image insertion rejects stale or blocked downloads, invalid bytes and cancellation before queueing',async()=>{
 for(const change of ['revision','ready','abort','invalid']){
  let revision='r1',ready=true,resolve;const controller=new AbortController()
  const access=createPdfImageAccess({fileId:'f',request:async()=>({revision,images:rows}),getRevision:()=>revision,isReady:()=>true,isDraftReady:()=>ready,write:async()=>false,fetchImage:async()=>new Promise(r=>{resolve=r}),queueInsert:async()=>assert.fail('invalid draft queued')})
  const pending=access.insertDraft({op:'insert_image',page:1,url:'https://example.com/a.png'},controller.signal)
  if(change==='revision')revision='r2';if(change==='ready')ready=false;if(change==='abort')controller.abort()
  resolve({mime:'image/png',base64:change==='invalid'?'AB==':'iVBORw0KGgo='})
  await assert.rejects(pending,change==='abort'?{name:'AbortError'}:undefined)
 }
})

test('saved image draft access marks claimed targets and queues geometry or replacement without immediate writes',async()=>{
 const queued=[],claimed=new Set(),access=createPdfImageAccess({fileId:'f',request:async()=>({revision:'r1',images:rows}),getRevision:()=> 'r1',isReady:()=>true,write:async()=>assert.fail('immediate write'),writeContent:async()=>assert.fail('immediate replacement'),fetchImage:async()=>({mime:'image/png',base64:'iVBORw0KGgo='}),queueEdit:async operation=>{queued.push(operation);claimed.add(`${operation.page}:${operation.image_number}`)},isClaimed:(page,number)=>claimed.has(`${page}:${number}`)})
 assert.equal(access.editsAreDrafts,true)
 await access.read();assert.equal(await access.edit({op:'rotate_image',page:1,image_number:1}),true)
 assert.equal((await access.read(1))[0].pending,true)
 assert.equal(await access.edit({op:'delete_image',page:1,image_number:1}),false)
 await access.read(2);assert.equal(await access.content({op:'replace_image',page:2,image_number:1,url:'https://example.com/photo.png'}),true)
 assert.deepEqual(queued,[{op:'rotate_image',page:1,image_number:1},{op:'replace_image',page:2,image_number:1,image:{mime:'image/png',base64:'iVBORw0KGgo='}}])
})
