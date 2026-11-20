import test from 'node:test'
import assert from 'node:assert/strict'
import {createPdfSavedImageDrafts} from '../../src/editors/pdf-saved-image-drafts.ts'
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg=='
function fixture(){
 let revision='r1',ready=true,release,fail=false
 const calls=[],options={fileId:'f',getRevision:()=>revision,isReady:()=>ready,onChange:()=>{},request:async(path,method,body,signal)=>{
  calls.push({path,method,body,signal});if(release)await new Promise(resolve=>release=resolve);if(fail)throw Error('native refused')
  return {revision:body.revision,pages:[...new Set(body.operation.imageEdits.map(op=>op.page))].map(page=>({page,width:500,height:600,png}))}
 }}
 return {drafts:createPdfSavedImageDrafts(options),calls,setRevision:value=>revision=value,setReady:value=>ready=value,setFail:value=>fail=value,delay:()=>release=()=>{},finish:()=>release?.()}
}
test('saved image operations queue against one source revision and undo locally before a single save batch',async()=>{
 const f=fixture(),operation={op:'transform_image',page:1,image_number:2,x:30}
 await f.drafts.queue(operation);operation.x=999
 assert.equal(f.calls[0].path,'/api/v1/files/f/pdf/draft-inserts/query');assert.equal(f.calls[0].body.revision,'r1')
 assert.deepEqual(f.drafts.operations(),[{op:'transform_image',page:1,image_number:2,x:30}])
 assert.equal(f.drafts.isClaimed(1,2),true)
 await assert.rejects(f.drafts.queue({op:'delete_image',page:1,image_number:2}),/待保存/)
 assert.equal(f.calls.length,1)
 await f.drafts.queue({op:'delete_image',page:2,image_number:1})
 assert.equal(f.calls[1].body.operation.imageEdits.length,2)
 assert.equal(f.drafts.undo(),true);assert.equal(f.drafts.isClaimed(2,1),false)
 const copy=f.drafts.list();copy[0].x=-1;assert.equal(f.drafts.operations()[0].x,30)
 assert.equal(f.calls.every(call=>call.path.endsWith('/query')),true)
 f.drafts.saved();assert.equal(f.drafts.hasPending(),false);assert.equal(f.drafts.canUndo(),false)
})
test('failed, stale, aborted and concurrent plans never replace saved-image draft state',async()=>{
 const f=fixture();await f.drafts.queue({op:'delete_image',page:1,image_number:1})
 f.setFail(true);await assert.rejects(f.drafts.queue({op:'rotate_image',page:1,image_number:2}),/native refused/)
 assert.equal(f.drafts.operations().length,1);f.setFail(false);f.delay()
 const controller=new AbortController(),pending=f.drafts.queue({op:'rotate_image',page:1,image_number:2},controller.signal)
 await new Promise(resolve=>setImmediate(resolve));await assert.rejects(f.drafts.queue({op:'delete_image',page:1,image_number:3}),/处理/)
 controller.abort();f.finish();await assert.rejects(pending,{name:'AbortError'});assert.equal(f.drafts.operations().length,1)
 const stale=f.drafts.queue({op:'rotate_image',page:1,image_number:2});await new Promise(resolve=>setImmediate(resolve));f.setRevision('r2');f.finish();await assert.rejects(stale,/版本/)
 assert.throws(()=>f.drafts.operations(),/版本/);f.drafts.discard();assert.equal(f.drafts.hasPending(),false)
})
test('discard invalidates in-flight image work and unavailable sessions cannot queue or undo',async()=>{
 const f=fixture();f.delay();const pending=f.drafts.queue({op:'delete_image',page:1,image_number:1})
 await new Promise(resolve=>setImmediate(resolve));f.drafts.discard();f.finish();await assert.rejects(pending,/状态|版本/);assert.equal(f.drafts.hasPending(),false)
 f.setReady(false);await assert.rejects(f.drafts.queue({op:'delete_image',page:1,image_number:1}),/不能/);assert.throws(()=>f.drafts.undo(),/不能/)
})
