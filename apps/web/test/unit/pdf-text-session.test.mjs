import test from 'node:test'
import assert from 'node:assert/strict'
import {createPdfPendingSession} from '../../src/editors/pdf-pending-session.ts'
import {createPdfTextDrafts} from '../../src/editors/pdf-text-drafts.ts'

const native=text=>({pageIndex:0,origin:[20,170],text,fontSize:12,color:[0,0,0],rotate:0})
function fixture(request){
 let changes=0
 const session=createPdfPendingSession({getContext:()=>({fileId:'file',baseRevision:'r1',pageGeometries:[{pw:300,ph:200,rot:0},{pw:300,ph:200,rot:0}],savedFields:[]}),onChange:()=>changes++})
 const drafts=createPdfTextDrafts({fileId:'file',getRevision:()=> 'r1',isReady:()=>true,onChange(){},session,request:request??(async(_url,_method,{operations})=>({revision:'r1',blocks:operations.map(op=>({page:op.page,text:op.text,x:20,y:18,width:100,height:14.4,font_size:12,color:'#000000',align:'left'})),inserts:operations.map(op=>native(op.text))}))})
 return {session,drafts,get changes(){return changes}}
}

test('text layouts and native inserts share canonical history and undo with metadata and pending deletion',async()=>{
 const f=fixture(),block=await f.drafts.insert({page:1,text:'Draft'})
 assert.equal(f.session.read().textInserts.length,1)
 assert.deepEqual(f.session.read().textInserts[0],{id:block.id,input:native('Draft')})
 assert.equal(f.changes,1)
 f.session.apply([{op:'removeTextInsert',id:block.id},{op:'setMetadata',metadata:{title:'Mixed'}}])
 assert.equal(f.drafts.list().length,0);assert.equal(f.session.read().metadata.title,'Mixed')
 f.drafts.undo();assert.equal(f.drafts.list()[0].id,block.id);assert.equal(f.session.read().metadata,null)
 f.session.redo();assert.equal(f.drafts.list().length,0)
 f.session.undo();f.drafts.undo();assert.equal(f.drafts.list().length,0);assert.equal(f.session.canUndo(),false)
})

test('canonical page deletion hides text layouts while retaining original raw page identity for undo',async()=>{
 const f=fixture();await f.drafts.insert({page:1,text:'Draft'})
 f.session.apply([{op:'deletePage',page:1}]);assert.equal(f.drafts.list().length,0);assert.equal(f.session.read().textInserts.length,1)
 f.session.undo();assert.equal(f.drafts.list().length,1);assert.equal(f.session.read().textInserts.length,1)
})

test('deleting the final text draft needs no layout request and remains one global undo step',async()=>{
 const f=fixture(),block=await f.drafts.insert({page:1,text:'Last'})
 await f.drafts.remove(block.id)
 assert.equal(f.session.read().textInserts.length,0);assert.equal(f.drafts.list().length,0)
 f.session.undo();assert.equal(f.drafts.list()[0].id,block.id)
})

test('empty text sidecars cannot be mutated before insertion or after discard',()=>{
 const f=fixture()
 assert.throws(()=>f.session.readTextDrafts().push({}),TypeError)
 f.session.discard();assert.throws(()=>f.session.readTextDrafts().push({}),TypeError)
 assert.equal(f.session.read().textInserts.length,0)
})

test('layout responses cannot overwrite newer canonical history and malformed native plans never enter the owner',async()=>{
 let resolve
 const f=fixture(()=>new Promise(done=>{resolve=done})),work=f.drafts.insert({page:1,text:'Draft'})
 f.session.apply([{op:'setMetadata',metadata:{title:'Newer'}}])
 resolve({revision:'r1',blocks:[{page:1,text:'Draft',x:20,y:18,width:100,height:14.4,font_size:12,color:'#000000',align:'left'}],inserts:[native('Draft')]})
 await assert.rejects(work);assert.equal(f.session.read().metadata.title,'Newer');assert.equal(f.drafts.list().length,0);assert.equal(f.changes,1)
 for(const inserts of [undefined,[],[native('Wrong text')],[{...native('Draft'),pageIndex:1}],[{...native('Draft'),fontSize:NaN}]]){
  const bad=fixture(async()=>({revision:'r1',blocks:[{page:1,text:'Draft',x:20,y:18,width:100,height:14.4,font_size:12,color:'#000000',align:'left'}],inserts}))
  await assert.rejects(bad.drafts.insert({page:1,text:'Draft'}));assert.equal(bad.session.canUndo(),false);assert.equal(bad.drafts.list().length,0)
 }
})
