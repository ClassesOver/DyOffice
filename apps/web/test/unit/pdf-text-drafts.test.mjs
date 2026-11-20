import test from 'node:test'
import assert from 'node:assert/strict'
import {createPdfTextDrafts} from '../../src/editors/pdf-text-drafts.ts'
import {createPdfPendingSession} from '../../src/editors/pdf-pending-session.ts'

function fixture(){
 let revision='r1',ready=true,changes=0
 const calls=[]
 const request=async(path,method,body)=>{
  calls.push({path,method,body})
  return {revision:body.revision,blocks:body.operations.map(op=>({page:op.page,text:op.text,x:op.x??120,y:op.y??72,width:80,height:24,font_size:op.font_size??20,color:op.color??'#000000',align:op.align??'left',line_widths:[80],...(op.max_width?{max_width:op.max_width}:{})}))}
 }
 const options={fileId:'pdf',request,getRevision:()=>revision,isReady:()=>ready,onChange:()=>changes++}
 const drafts=createPdfTextDrafts(options)
 return {drafts,calls,options,setRevision:value=>revision=value,setReady:value=>ready=value,get changes(){return changes}}
}
test('a draft rotates with its page and moving it in the displayed direction preserves its native orientation',async()=>{
 const f=fixture(),geom={pw:500,ph:600,rot:0}
 const session=createPdfPendingSession({getContext:()=>({fileId:'pdf',baseRevision:'r1',pageGeometries:[geom],savedFields:[]}),onChange:()=>{}})
 const drafts=createPdfTextDrafts({...f.options,session,pageGeometry:()=>geom,request:async(...args)=>{
  const result=await f.options.request(...args)
  return {...result,inserts:result.blocks.map(b=>({pageIndex:0,text:b.text,origin:[b.x,600-b.y-b.font_size],fontSize:b.font_size,color:[0,0,0],rotate:0}))}
 }})
 const {id}=await drafts.insert({page:1,text:'Earlier',x:120,y:72})
 assert.deepEqual(session.apply([{op:'rotatePages',pages:[1],dir:90}]).failures,[])
 const bounds=()=>{const [{x,y,width,height}]=drafts.list();return [x,y,width,height]}
 assert.deepEqual(bounds(),[504,120,24,80])
 await drafts.move({id,dx:10,dy:20})
 assert.deepEqual(bounds(),[514,140,24,80])
 assert.deepEqual(drafts.operations(),[{page:1,text:'Earlier',x:140,y:62}])
 assert.equal(session.read().textInserts[0].input.rotate,0)
 assert.equal(session.undo(),true);assert.deepEqual(bounds(),[504,120,24,80])
 assert.equal(session.undo(),true);assert.deepEqual(bounds(),[120,72,80,24])
})
test('pending text keeps anchored edits, moves, deletion and undo local until one batch is saved',async()=>{
 const f=fixture(),a=await f.drafts.insert({page:1,text:'Draft',anchor_text:'Anchor',placement:'below'})
 assert.match(a.id,/^T/);assert.equal(f.drafts.hasPending(),true)
 assert.equal(f.calls[0].path,'/api/v1/files/pdf/pdf/text-inserts/query')
 const edited=await f.drafts.edit({id:a.id,text:'Final',color:'#123456'})
 assert.equal(edited.id,a.id)
 assert.deepEqual(f.calls[1].body.operations,[{page:1,text:'Final',x:120,y:72,color:'#123456'}])
 await f.drafts.move({id:a.id,dx:10,dy:15})
 assert.deepEqual(f.drafts.operations(),[{page:1,text:'Final',x:130,y:87,color:'#123456'}])
 await f.drafts.remove(a.id);assert.deepEqual(f.drafts.list(),[])
 assert.equal(f.drafts.undo(),true);assert.equal(f.drafts.list()[0].x,130)
 assert.equal(f.drafts.undo(),true);assert.equal(f.drafts.list()[0].x,120)
 assert.equal(f.calls.every(call=>call.method==='POST'&&call.path.endsWith('/query')),true)
 f.drafts.saved();assert.equal(f.drafts.hasPending(),false);assert.equal(f.drafts.canUndo(),false)
 await assert.rejects(f.drafts.remove(a.id),/不存在/)
})
test('stale, canceled or concurrent draft plans never overwrite the current session',async()=>{
 const f=fixture();let finish
 const drafts=createPdfTextDrafts({...f.options,request:async(...args)=>{const result=await f.options.request(...args);await new Promise(resolve=>finish=resolve);return result}})
 const controller=new AbortController(),pending=drafts.insert({page:1,text:'Late'},controller.signal)
 await new Promise(resolve=>setImmediate(resolve))
 await assert.rejects(drafts.insert({page:1,text:'Other'}),/稍候/)
 controller.abort();finish();await assert.rejects(pending,{name:'AbortError'});assert.equal(drafts.hasPending(),false)
 const changed=drafts.insert({page:1,text:'Stale'})
 await new Promise(resolve=>setImmediate(resolve));f.setRevision('r2');finish()
 await assert.rejects(changed,/版本/);assert.equal(drafts.hasPending(),false)
})
test('draft snapshots cannot be mutated and guards reject unavailable or mismatched revisions',async()=>{
 const f=fixture(),a=await f.drafts.insert({page:1,text:'Original'})
 const snapshot=f.drafts.list();snapshot[0].text='Overwritten';snapshot[0].line_widths[0]=1
 const operations=f.drafts.operations();operations[0].text='Other'
 assert.equal(f.drafts.list()[0].text,'Original');assert.equal(f.drafts.list()[0].line_widths[0],80)
 f.setReady(false);await assert.rejects(f.drafts.edit({id:a.id,text:'No'}),/当前/)
 f.setReady(true);f.setRevision('r2');await assert.rejects(f.drafts.move({id:a.id,x:1}),/版本/)
 assert.throws(()=>f.drafts.operations(),/版本/)
 f.drafts.discard();assert.equal(f.drafts.hasPending(),false)
 assert.equal((await f.drafts.insert({page:1,text:'New'})).text,'New')
})
test('invalid preview metadata is not accepted as a successful draft',async()=>{
 const f=fixture()
 for(const replace of [r=>({...r,revision:'wrong'}),r=>({...r,blocks:[]}),r=>({...r,blocks:[{...r.blocks[0],width:NaN}]}),r=>({...r,blocks:[{...r.blocks[0],page:2}]})]){
  const drafts=createPdfTextDrafts({...f.options,request:async(...args)=>replace(await f.options.request(...args))})
  await assert.rejects(drafts.insert({page:1,text:'Invalid'}),/预览/);assert.equal(drafts.hasPending(),false)
 }
})
test('adding a block replans the entire batch so shared font fallback cannot leave older previews stale',async()=>{
 const f=fixture()
 const drafts=createPdfTextDrafts({...f.options,request:async(...args)=>{
  const result=await f.options.request(...args),combined=result.blocks.some(block=>block.text.includes('中文'))
  return {...result,blocks:result.blocks.map(block=>({...block,width:combined?95:80,line_widths:[combined?95:80]}))}
 }})
 const first=await drafts.insert({page:1,text:'First Latin block'})
 assert.equal(first.width,80)
 await drafts.insert({page:1,text:'中文'})
 assert.equal(f.calls[1].body.operations.length,2)
 assert.equal(drafts.list()[0].id,first.id)
 assert.equal(drafts.list()[0].width,95)
 assert.deepEqual(drafts.operations().map(op=>op.text),['First Latin block','中文'])
 const second=drafts.list()[1]
 await drafts.remove(second.id)
 assert.equal(drafts.list()[0].width,80)
 assert.equal(drafts.list()[0].id,first.id)
 assert.equal(f.calls[2].body.operations.length,1)
 drafts.undo();assert.equal(drafts.list()[0].width,95);assert.equal(drafts.list()[1].id,second.id)
 assert.equal(f.calls.length,3)
})

test('failed or canceled deletion preserves the entire draft batch and its history',async()=>{
 const f=fixture();let fail=false,finish
 const drafts=createPdfTextDrafts({...f.options,request:async(...args)=>{
  if(fail)throw Error('Unavailable')
  const result=await f.options.request(...args)
  if(finish)await new Promise(resolve=>finish=resolve)
  return result
 }})
 const first=await drafts.insert({page:1,text:'First'}),second=await drafts.insert({page:2,text:'Second'}),before=drafts.list()
 fail=true;await assert.rejects(drafts.remove(second.id),/Unavailable/)
 assert.deepEqual(drafts.list(),before);assert.equal(drafts.isBusy(),false)
 fail=false;finish=()=>{};const controller=new AbortController(),pending=drafts.remove(second.id,controller.signal)
 await new Promise(resolve=>setImmediate(resolve));assert.equal(drafts.isBusy(),true)
 controller.abort();finish();await assert.rejects(pending,{name:'AbortError'})
 assert.deepEqual(drafts.list(),before);assert.equal(drafts.isBusy(),false)
 drafts.undo();assert.deepEqual(drafts.list().map(block=>block.id),[first.id])
})

test('canonical text removal validates the whole batch and removes multiple drafts in one undo step',async()=>{
 const f=fixture(),first=await f.drafts.insert({page:1,text:'First'}),second=await f.drafts.insert({page:1,text:'Second'}),third=await f.drafts.insert({page:2,text:'Third'})
 const before=f.drafts.list(),requests=f.calls.length
 await assert.rejects(f.drafts.removeMany([first.id,'S12R']),/T ID/)
 await assert.rejects(f.drafts.removeMany([first.id,'Pnote']),/T ID/)
 assert.deepEqual(f.drafts.list(),before);assert.equal(f.calls.length,requests)
 await f.drafts.removeMany([first.id,third.id,first.id,'Tmissing'])
 assert.deepEqual(f.drafts.list().map(block=>block.id),[second.id])
 assert.equal(f.calls.length,requests+1)
 assert.deepEqual(f.calls.at(-1).body.operations,[{page:1,text:'Second',x:120,y:72}])
 assert.equal(f.drafts.undo(),true);assert.deepEqual(f.drafts.list(),before)
 f.drafts.undo();assert.deepEqual(f.drafts.list().map(block=>block.id),[first.id,second.id])
})

test('canonical text batch removal keeps drafts and undo history on preview failure, cancellation or revision change',async()=>{
 const f=fixture();let mode='ok',finish
 const drafts=createPdfTextDrafts({...f.options,request:async(...args)=>{
  if(mode==='fail')throw Error('Layout unavailable')
  const result=await f.options.request(...args)
  if(mode==='wait')await new Promise(resolve=>finish=resolve)
  return result
 }})
 const first=await drafts.insert({page:1,text:'First'}),second=await drafts.insert({page:1,text:'Second'}),third=await drafts.insert({page:2,text:'Third'}),before=drafts.list()
 mode='fail';await assert.rejects(drafts.removeMany([first.id,second.id]),/unavailable/)
 assert.deepEqual(drafts.list(),before);assert.equal(drafts.isBusy(),false)
 mode='wait';const controller=new AbortController(),canceled=drafts.removeMany([first.id,second.id],controller.signal)
 await new Promise(resolve=>setImmediate(resolve));controller.abort();finish()
 await assert.rejects(canceled,{name:'AbortError'});assert.deepEqual(drafts.list(),before)
 const stale=drafts.removeMany([first.id,second.id])
 await new Promise(resolve=>setImmediate(resolve));f.setRevision('r2');finish()
 await assert.rejects(stale,/版本/);assert.deepEqual(drafts.list(),before)
 f.setRevision('r1');drafts.undo();assert.deepEqual(drafts.list().map(block=>block.id),[first.id,second.id]);assert.ok(!drafts.list().some(block=>block.id===third.id))
})

test('unknown canonical text deletions are local idempotent no-ops even while preview service is unavailable',async()=>{
 const f=fixture();let offline=false
 const drafts=createPdfTextDrafts({...f.options,request:async(...args)=>{if(offline)throw Error('offline');return f.options.request(...args)}})
 const first=await drafts.insert({page:1,text:'Keep'}),before=drafts.list()
 offline=true;await drafts.removeMany(['Tmissing','Tmissing'])
 assert.deepEqual(drafts.list(),before);assert.equal(f.calls.length,1)
 drafts.undo();assert.deepEqual(drafts.list(),before)
 drafts.undo();assert.deepEqual(drafts.list(),[])
 assert.match(first.id,/^T/)
})
