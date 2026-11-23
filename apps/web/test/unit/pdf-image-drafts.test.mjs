import test from 'node:test'
import assert from 'node:assert/strict'
import {PNG} from 'pngjs'
import {createPdfImageDrafts} from '../../src/editors/pdf-image-drafts.ts'
import {inspectPdfImageDraftBytes,applyPdfImageDraftPixels,getPdfImageDraftCrop} from '../../src/editors/pdf-image-draft-pixels.ts'
const image=(w=4,h=2,alpha=255)=>{const png=new PNG({width:w,height:h});for(let i=0;i<png.data.length;i+=4){png.data[i]=i;png.data[i+1]=100;png.data[i+2]=200;png.data[i+3]=alpha}return {mime:'image/png',base64:PNG.sync.write(png).toString('base64')}}
function fixture(){
 let revision='r1',ready=true,fail=false,release
 const calls=[],pixelCalls=[]
 const options={fileId:'f',getRevision:()=>revision,isReady:()=>ready,onChange:()=>{},request:async(path,method,body,signal)=>{
  calls.push({path,method,body,signal});if(fail)throw Error('query failed')
  if(release)await new Promise(resolve=>release=resolve)
  const o=body.operation,{width:pixelWidth,height:pixelHeight}=inspectPdfImageDraftBytes(o.image)
  return {revision:body.revision,image:{page:o.page,x:o.x??50,y:o.y??60,width:o.width??100,height:o.height??(o.width??100)*pixelHeight/pixelWidth,layer:o.layer??'below_text',pixelWidth,pixelHeight}}
 },transformPixels:async(input,op)=>{
  pixelCalls.push({input,op});const p=PNG.sync.read(Buffer.from(input.base64,'base64')),result=applyPdfImageDraftPixels({width:p.width,height:p.height,data:new Uint8ClampedArray(p.data)},op)
  return {mime:'image/png',base64:PNG.sync.write({width:result.width,height:result.height,data:Buffer.from(result.data)}).toString('base64')}
 }}
 return {drafts:createPdfImageDrafts(options),options,calls,pixelCalls,setRevision:r=>revision=r,setReady:v=>ready=v,setFail:v=>fail=v,delay:()=>{release=()=>{}},finish:()=>release?.()}
}
test('pending image inserts, transforms and deletes stay local and expose one canonical save batch',async()=>{
 const f=fixture(),bytes=image(),a=await f.drafts.insert({op:'insert_image',page:1,image:bytes,anchor_text:'Anchor',placement:'below',width:100})
 assert.match(a.id,/^I/);assert.equal(a.x,50);assert.equal(a.height,50);assert.equal(f.drafts.hasPending(),true)
 assert.equal(f.calls[0].path,'/api/v1/files/f/pdf/image-inserts/query');assert.equal(f.calls[0].body.revision,'r1')
 await f.drafts.transform(a.id,{x:70,width:80});assert.equal(f.drafts.list()[0].height,40)
 assert.deepEqual(f.drafts.operations(),[{page:1,image:bytes,x:70,y:60,width:80,height:40,layer:'below_text'}])
 const cloned=f.drafts.list();cloned[0].image.base64='bad';assert.equal(f.drafts.list()[0].image.base64,bytes.base64)
 f.drafts.remove(a.id);assert.equal(f.drafts.hasPending(),false);assert.equal(f.drafts.undo(),true);assert.equal(f.drafts.list()[0].id,a.id)
 assert.equal(f.calls.every(call=>call.path.endsWith('/query')),true)
 f.drafts.saved();assert.equal(f.drafts.hasPending(),false);assert.equal(f.drafts.canUndo(),false)
})
test('bakes rewrite pixels, crop keeps placement, rotation stays centered and opacity is absolute',async()=>{
 const f=fixture(),a=await f.drafts.insert({op:'insert_image',page:1,image:image(),x:20,y:30,width:100})
 const half=await f.drafts.bake(a.id,{kind:'opacity',value:.5});assert.equal(PNG.sync.read(Buffer.from(half.image.base64,'base64')).data[3],128)
 const opaque=await f.drafts.bake(a.id,{kind:'opacity',value:1});assert.equal(PNG.sync.read(Buffer.from(opaque.image.base64,'base64')).data[3],255)
 const crop=await f.drafts.bake(a.id,{kind:'crop',left:.25,right:.25,top:0,bottom:0});assert.equal(crop.x,45);assert.equal(crop.width,50);assert.equal(crop.height,50);assert.equal(crop.pixelWidth,2)
 const rotated=await f.drafts.bake(a.id,{kind:'rotate',direction:'cw'});assert.equal(rotated.x,45);assert.equal(rotated.y,30);assert.equal(rotated.width,50)
 const flipped=await f.drafts.bake(a.id,{kind:'flip',axis:'horizontal'});assert.notEqual(flipped.image.base64,rotated.image.base64)
 await f.drafts.bake(a.id,{kind:'cutout',tolerance:30});assert.equal(f.pixelCalls.length,6)
 f.drafts.undo();assert.deepEqual(f.drafts.list()[0],flipped)
})
test('failed, stale, aborted or concurrent image queries do not overwrite pending state',async()=>{
 const f=fixture(),a=await f.drafts.insert({op:'insert_image',page:1,image:image()})
 f.setFail(true);await assert.rejects(f.drafts.transform(a.id,{x:123}),/query failed/);assert.deepEqual(f.drafts.list(),[a])
 f.setFail(false);f.delay();const controller=new AbortController(),pending=f.drafts.bake(a.id,{kind:'opacity',value:.3},controller.signal)
 await new Promise(resolve=>setImmediate(resolve));await assert.rejects(f.drafts.transform(a.id,{x:1}),/稍候/)
 controller.abort();f.finish();await assert.rejects(pending,{name:'AbortError'});assert.deepEqual(f.drafts.list(),[a]);assert.equal(f.drafts.isBusy(),false)
 const stale=f.drafts.transform(a.id,{x:1});await new Promise(resolve=>setImmediate(resolve));f.setRevision('r2');f.finish();await assert.rejects(stale,/版本/)
 assert.throws(()=>f.drafts.operations(),/版本/);f.drafts.discard();assert.equal(f.drafts.hasPending(),false)
})
test('image pixel gates reject dimensions before allocating and pure helpers use PC pixel algorithms',()=>{
 const huge=Buffer.from(image().base64,'base64');huge.writeUInt32BE(8193,16)
 assert.throws(()=>inspectPdfImageDraftBytes({mime:'image/png',base64:huge.toString('base64')}),/限制/)
 assert.throws(()=>inspectPdfImageDraftBytes({mime:'image/png',base64:'bad!'}))
 const source={width:2,height:1,data:new Uint8ClampedArray([255,0,0,255,0,0,255,128])}
 assert.deepEqual([...applyPdfImageDraftPixels(source,{kind:'flip',axis:'horizontal'}).data],[0,0,255,128,255,0,0,255])
 assert.deepEqual([...applyPdfImageDraftPixels(source,{kind:'opacity',value:.5}).data],[255,0,0,128,0,0,255,64])
 const rotated=applyPdfImageDraftPixels(source,{kind:'rotate',direction:'cw'});assert.equal(rotated.width,1);assert.equal(rotated.height,2)
 assert.deepEqual(getPdfImageDraftCrop(4,2,{kind:'crop',left:.25,right:.25,top:0,bottom:0}),{x:1,y:0,width:2,height:2})
 assert.throws(()=>getPdfImageDraftCrop(2,1,{kind:'crop',left:.01}),/像素/)
 const cutout=applyPdfImageDraftPixels({width:3,height:3,data:new Uint8ClampedArray([255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,0,0,0,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255])},{kind:'cutout',tolerance:0})
 assert.equal(cutout.data[3],0);assert.equal(cutout.data[19],255)
})

test('pixel bakes preserve dimensions exposed by native ImageData prototype getters',()=>{
 const data=new Uint8ClampedArray([255,255,255,255,0,0,255,255])
 const source=Object.create({get width(){return 2},get height(){return 1},get data(){return data}})
 for(const operation of [{kind:'flip',axis:'horizontal'},{kind:'opacity',value:.8},{kind:'cutout',tolerance:0}]){
  const result=applyPdfImageDraftPixels(source,operation)
  assert.equal(result.width,2);assert.equal(result.height,1)
 }
 assert.equal(applyPdfImageDraftPixels(source,{kind:'opacity',value:.8}).data[3],204)
})

test('invalid inputs and 21st image never reach query or pixel callbacks',async()=>{
 const f=fixture(),valid={op:'insert_image',page:1,image:image()}
 for(const patch of [{page:0},{page:101},{page:'1'},{width:0},{height:-1},{x:Infinity},{layer:'invalid'},{placement:'sideways'},{anchor_text:''},{image:{mime:'image/webp',base64:valid.image.base64}},{unexpected:true}])await assert.rejects(f.drafts.insert({...valid,...patch}))
 assert.equal(f.calls.length,0)
 for(let i=0;i<20;i++)await f.drafts.insert(valid)
 await assert.rejects(f.drafts.insert(valid),/20/);assert.equal(f.calls.length,20)
 const id=f.drafts.list()[0].id
 for(const op of [{kind:'flip',axis:'bad'},{kind:'opacity',value:1.1},{kind:'opacity',value:NaN},{kind:'rotate',direction:'bad'},{kind:'crop',left:.8,right:.3},{kind:'crop',left:-.1},{kind:'crop'},{kind:'cutout',tolerance:101},{kind:'flip',axis:'horizontal',extra:1}])await assert.rejects(f.drafts.bake(id,op))
 assert.equal(f.pixelCalls.length,0);assert.equal(f.calls.length,20)
 f.setReady(false);assert.throws(()=>f.drafts.remove(id),/当前/);await assert.rejects(f.drafts.transform(id,{x:1}),/当前/)
})

test('rotations exchange the footprint around its center and other bakes reset opacity base',async()=>{
 const f=fixture(),a=await f.drafts.insert({op:'insert_image',page:1,image:image(),x:100,y:100,width:100})
 const rotated=await f.drafts.bake(a.id,{kind:'rotate',direction:'cw'})
 assert.deepEqual([rotated.x,rotated.y,rotated.width,rotated.height,rotated.pixelWidth,rotated.pixelHeight],[125,75,50,100,2,4])
 await f.drafts.bake(a.id,{kind:'opacity',value:.5})
 await f.drafts.bake(a.id,{kind:'flip',axis:'vertical'})
 const full=await f.drafts.bake(a.id,{kind:'opacity',value:1})
 assert.equal(PNG.sync.read(Buffer.from(full.image.base64,'base64')).data[3],128)
 assert.equal(full.x,rotated.x);assert.equal(full.y,rotated.y)
})

test('replacing pending image bytes preserves its footprint and resets opacity base',async()=>{
 const f=fixture(),a=await f.drafts.insert({op:'insert_image',page:2,image:image(),x:30,y:40,width:80,height:70,layer:'above_text'})
 const faded=await f.drafts.bake(a.id,{kind:'opacity',value:.5})
 const replacement=image(3,5,200),replaced=await f.drafts.replace(a.id,replacement)
 assert.deepEqual([replaced.id,replaced.page,replaced.x,replaced.y,replaced.width,replaced.height,replaced.layer],[a.id,2,30,40,80,70,'above_text'])
 assert.deepEqual([replaced.pixelWidth,replaced.pixelHeight],[3,5]);assert.deepEqual(replaced.image,replacement)
 const opaque=await f.drafts.bake(a.id,{kind:'opacity',value:1});assert.equal(PNG.sync.read(Buffer.from(opaque.image.base64,'base64')).data[3],200)
 f.drafts.undo();assert.deepEqual(f.drafts.list()[0],replaced)
 f.drafts.undo();assert.deepEqual(f.drafts.list()[0],faded)
})

test('invalid, failed, stale and canceled image replacements leave old bytes intact',async()=>{
 const f=fixture(),a=await f.drafts.insert({op:'insert_image',page:1,image:image()})
 await assert.rejects(f.drafts.replace(a.id,{mime:'image/webp',base64:a.image.base64}));assert.equal(f.calls.length,1)
 f.setFail(true);await assert.rejects(f.drafts.replace(a.id,image(3,3)),/query failed/);assert.deepEqual(f.drafts.list(),[a])
 f.setFail(false);f.delay();const controller=new AbortController(),pending=f.drafts.replace(a.id,image(3,3),controller.signal)
 await new Promise(resolve=>setImmediate(resolve));controller.abort();f.finish();await assert.rejects(pending,{name:'AbortError'});assert.deepEqual(f.drafts.list(),[a])
 const stale=f.drafts.replace(a.id,image(3,3));await new Promise(resolve=>setImmediate(resolve));f.setRevision('r2');f.finish();await assert.rejects(stale,/版本/);assert.deepEqual(f.drafts.list(),[a])
})

test('discard invalidates an in-flight pixel/query result and history stays bounded',async()=>{
 const f=fixture(),a=await f.drafts.insert({op:'insert_image',page:1,image:image()})
 for(let i=0;i<60;i++)await f.drafts.transform(a.id,{x:i})
 let undo=0;while(f.drafts.undo())undo++;assert.equal(undo,50)
 f.delay();const pending=f.drafts.transform(a.id,{x:123});await new Promise(resolve=>setImmediate(resolve))
 f.drafts.discard();f.finish();await assert.rejects(pending,/版本|状态/)
 assert.equal(f.drafts.hasPending(),false);assert.equal(f.drafts.isBusy(),false)
})

test('a caller cannot mutate retained opacity bytes while insertion is awaiting its query',async()=>{
 const f=fixture(),source=image();f.delay()
 const pending=f.drafts.insert({op:'insert_image',page:1,image:source})
 await new Promise(resolve=>setImmediate(resolve));source.base64='bad';f.finish()
 const info=await pending
 f.finish();const transformed=f.drafts.bake(info.id,{kind:'opacity',value:1})
 await new Promise(resolve=>setImmediate(resolve));f.finish()
 assert.equal((await transformed).image.base64,info.image.base64)
})

test('compressed live bytes, malformed metadata and oversized pixel outputs fail without changing drafts',async()=>{
 const f=fixture(),large=new PNG({width:1024,height:1024});large.data.fill(128)
 const repeated={mime:'image/png',base64:PNG.sync.write(large,{deflateLevel:0}).toString('base64')}
 for(let i=0;i<4;i++)await f.drafts.insert({op:'insert_image',page:1,image:repeated})
 await assert.rejects(f.drafts.insert({op:'insert_image',page:1,image:repeated}),/20 MiB/)
 assert.equal(f.calls.length,4)
 for(const patch of [{revision:'r2'},{image:{page:1,x:0,y:0,width:1,height:1,layer:'below_text',pixelWidth:999,pixelHeight:1}}]){
  const drafts=createPdfImageDrafts({...f.options,request:async(...args)=>({...await f.options.request(...args),...patch})})
  await assert.rejects(drafts.insert({op:'insert_image',page:1,image:image()}),/预览/);assert.equal(drafts.hasPending(),false)
 }
 const bad=createPdfImageDrafts({...f.options,transformPixels:async()=>({mime:'image/png',base64:'AAAA'.repeat(1800000)})})
 const a=await bad.insert({op:'insert_image',page:1,image:image()})
 await assert.rejects(bad.bake(a.id,{kind:'opacity',value:.5}),/限制/);assert.deepEqual(bad.list(),[a])
})
