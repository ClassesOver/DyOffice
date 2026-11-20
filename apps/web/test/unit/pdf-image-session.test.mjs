import test from 'node:test'
import assert from 'node:assert/strict'
import {PNG} from 'pngjs'
import {createPdfPendingSession} from '../../src/editors/pdf-pending-session.ts'
import {createPdfImageDrafts} from '../../src/editors/pdf-image-drafts.ts'
import {createPdfTextDrafts} from '../../src/editors/pdf-text-drafts.ts'
import {applyPdfImageDraftPixels,inspectPdfImageDraftBytes} from '../../src/editors/pdf-image-draft-pixels.ts'
const image=()=>{const p=new PNG({width:4,height:2});p.data.fill(255);return {mime:'image/png',base64:PNG.sync.write(p).toString('base64')}}
const native=(info)=>({kind:'insertImage',pageIndex:info.page-1,image:info.image.base64,rect:[info.x,200-info.y-info.height,info.x+info.width,200-info.y],layer:info.layer==='above_text'?'aboveText':'belowText',rotate:0})
function fixture({request,transformPixels}={}){let changes=0;const session=createPdfPendingSession({getContext:()=>({fileId:'f',baseRevision:'r1',pageGeometries:[{pw:300,ph:200,rot:0},{pw:300,ph:200,rot:0}],savedFields:[]}),onChange:()=>changes++}),options={fileId:'f',getRevision:()=> 'r1',isReady:()=>true,onChange(){},session,request:request??(async(_p,_m,{revision,operation:o})=>{const d=inspectPdfImageDraftBytes(o.image),info={page:o.page,x:o.x??20,y:o.y??30,width:o.width??100,height:o.height??50,layer:o.layer??'below_text',pixelWidth:d.width,pixelHeight:d.height};return {revision,image:info,edit:native({...info,image:o.image})}}),transformPixels:transformPixels??(async(input,op)=>{const p=PNG.sync.read(Buffer.from(input.base64,'base64')),result=applyPdfImageDraftPixels({width:p.width,height:p.height,data:new Uint8ClampedArray(p.data)},op);return {mime:'image/png',base64:PNG.sync.write({width:result.width,height:result.height,data:Buffer.from(result.data)}).toString('base64')}})};return {session,drafts:createPdfImageDrafts(options),options,get changes(){return changes}}}
const add=f=>f.drafts.insert({op:'insert_image',page:1,image:image()})

test('T then I then canonical removal all share one history and undo restores both sidecars and raw payloads',async()=>{
 const f=fixture(),texts=createPdfTextDrafts({...f.options,request:async(_p,_m,{operations})=>({revision:'r1',blocks:operations.map(o=>({page:o.page,text:o.text,x:20,y:18,width:100,height:14.4,font_size:12,color:'#000000',align:'left'})),inserts:operations.map(o=>({pageIndex:o.page-1,origin:[20,170],text:o.text,fontSize:12,color:[0,0,0],rotate:0}))})}),text=await texts.insert({page:1,text:'Text'}),pic=await add(f)
 assert.equal(f.session.read().imageEdits.length,1);assert.deepEqual(f.session.read().imageEdits[0],{id:pic.id,input:native(pic)});assert.equal(f.session.readImageDrafts()[0].info.id,pic.id)
 f.session.apply([{op:'removeTextInsert',id:text.id}]);assert.equal(texts.list().length,0);assert.equal(f.drafts.list().length,1)
 f.drafts.undo();assert.equal(texts.list()[0].id,text.id);assert.equal(f.drafts.list()[0].id,pic.id)
 texts.undo();assert.equal(f.drafts.list().length,0);assert.equal(f.session.read().imageEdits.length,0);assert.equal(texts.list().length,1)
 f.session.redo();assert.equal(f.drafts.list()[0].id,pic.id);assert.equal(f.changes,6)
})

test('image transforms removal opacity and canonical deletion use global undo and original page identities',async()=>{
 const f=fixture(),pic=await add(f),faded=await f.drafts.bake(pic.id,{kind:'opacity',value:.5})
 assert.equal(PNG.sync.read(Buffer.from(faded.image.base64,'base64')).data[3],128)
 f.session.apply([{op:'setMetadata',metadata:{title:'Keep'}}]);f.session.undo();f.session.undo()
 assert.equal(f.drafts.list()[0].image.base64,pic.image.base64)
 const opaque=await f.drafts.bake(pic.id,{kind:'opacity',value:1});assert.equal(opaque.image.base64,pic.image.base64)
 await f.drafts.transform(pic.id,{x:40});assert.equal(f.session.read().imageEdits[0].input.rect[0],40)
 f.session.apply([{op:'deletePage',page:1}]);assert.equal(f.drafts.list().length,0);assert.equal(f.session.read().imageEdits[0].input.pageIndex,0);assert.equal(f.session.readImageDrafts().length,1)
 f.session.undo();assert.equal(f.drafts.list()[0].x,40)
 f.drafts.remove(pic.id);assert.equal(f.session.read().imageEdits.length,0);f.session.undo();assert.equal(f.drafts.list()[0].id,pic.id)
 assert.throws(()=>{f.session.readImageDrafts()[0].info.image.base64='bad'},TypeError)
})

test('owner rejects malformed image payloads atomically without changing image history',async()=>{
 const f=fixture(),pic=await add(f),before=f.session.read(),entry=f.session.readImageDrafts()[0],raw=before.imageEdits[0].input
 for(const edit of [{...raw,pageIndex:1},{...raw,image:'bad'},{...raw,rect:[1,2,1,3]},{...raw,kind:'deleteImage'},{...raw,layer:'bad'},{...raw,unknown:1}]){assert.throws(()=>f.session.replaceImageDrafts([entry],[edit],before));assert.equal(f.session.read(),before)}
 assert.equal(f.session.canUndo(),true);f.drafts.remove(pic.id);f.session.undo();assert.deepEqual(f.session.read().imageEdits[0].input,raw)
})

test('canonical mutations during pixel and query awaits reject stale image results without independent history',async()=>{
 for(const phase of ['pixels','query']){let release;const wait=new Promise(resolve=>release=resolve),f=fixture(phase==='pixels'?{transformPixels:async input=>{await wait;return input}}:{request:async()=>{await wait;const info={page:1,x:20,y:30,width:100,height:50,layer:'below_text',pixelWidth:4,pixelHeight:2};return {revision:'r1',image:info,edit:native({...info,image:image()})}}})
  let work;if(phase==='pixels'){const pic=await add(f);work=f.drafts.bake(pic.id,{kind:'opacity',value:.5})}else work=add(f)
  f.session.apply([{op:'setMetadata',metadata:{title:'Newer'}}]);const before=f.session.read();release();await assert.rejects(work,/版本|状态/);assert.equal(f.session.read(),before);assert.equal(f.drafts.isBusy(),false)
 }
})

function paddedImage(index){const source=Buffer.from(image().base64,'base64'),bytes=Buffer.alloc(5*1024*1024);source.copy(bytes);bytes[bytes.length-1]=index;return {mime:'image/png',base64:bytes.toString('base64')}}
const prepared=(id,bytes)=>{const info={id,page:1,x:20,y:30,width:100,height:50,layer:'below_text',pixelWidth:4,pixelHeight:2,image:bytes};return {entry:{info,opacityBase:bytes},edit:native(info)}}
test('owner caps aggregate writer payload separately from deduplicated sidecar and history memory',()=>{
 const f=fixture(),shared=paddedImage(1),same=Array.from({length:4},(_,i)=>prepared('I'+i,shared));f.session.replaceImageDrafts(same.map(p=>p.entry),same.map(p=>p.edit),f.session.read());assert.equal(f.session.read().imageEdits.length,4);const fifth=prepared('Ififth',shared),tooMany=[...same,fifth],sharedBefore=f.session.read();assert.throws(()=>f.session.replaceImageDrafts(tooMany.map(p=>p.entry),tooMany.map(p=>p.edit),sharedBefore),/20 MiB/);assert.equal(f.session.read(),sharedBefore)
 const unique=Array.from({length:5},(_,i)=>prepared('I'+i,paddedImage(i+1))),before=f.session.read();assert.throws(()=>f.session.replaceImageDrafts(unique.map(p=>p.entry),unique.map(p=>p.edit),before),/20 MiB/);assert.equal(f.session.read(),before)
 const four=unique.slice(0,4);f.session.replaceImageDrafts(four.map(p=>p.entry),four.map(p=>p.edit),f.session.read());const withBase=structuredClone(four.map(p=>p.entry));withBase[0].opacityBase=paddedImage(9);const current=f.session.read();assert.throws(()=>f.session.replaceImageDrafts(withBase,four.map(p=>p.edit),current),/20 MiB/);assert.equal(f.session.read(),current)
 f.session.discard();for(let i=1;i<=11;i++){const p=prepared('Ione',paddedImage(i));f.session.replaceImageDrafts([p.entry],[p.edit],f.session.read())}
 let undos=0;while(f.session.undo())undos++;assert.ok(undos<=8);assert.ok(undos>=7)
})


test('empty image sidecars stay immutable before the first image and after discard',()=>{
 const f=fixture();assert.throws(()=>f.session.readImageDrafts().push({}),TypeError);f.session.discard();assert.throws(()=>f.session.readImageDrafts().push({}),TypeError)
})


test('five valid repeated PNG inserts exceeding the native aggregate limit reject without a history step',async()=>{
 const f=fixture(),png=new PNG({width:1024,height:1024});png.data.fill(128);const bytes={mime:'image/png',base64:PNG.sync.write(png,{deflateLevel:0}).toString('base64')},size=Buffer.from(bytes.base64,'base64').length
 assert.ok(size*4<=20*1024*1024);assert.ok(size*5>20*1024*1024)
 for(let i=0;i<4;i++)await f.drafts.insert({op:'insert_image',page:1,image:bytes})
 const before=f.session.read(),changes=f.changes
 await assert.rejects(f.drafts.insert({op:'insert_image',page:1,image:bytes}),/20 MiB/)
 assert.equal(f.session.read(),before);assert.equal(f.changes,changes);assert.equal(f.drafts.list().length,4)
})
