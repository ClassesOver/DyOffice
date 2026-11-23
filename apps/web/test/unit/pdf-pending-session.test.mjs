import test from 'node:test'
import assert from 'node:assert/strict'
import {createPdfPendingSession} from '../../src/editors/pdf-pending-session.ts'

function fixture(){
 let context={fileId:'pdf',baseRevision:'r1',pageGeometries:[{pw:500,ph:600,x0:0,y0:0,rot:0,userUnit:1},{pw:500,ph:600,x0:0,y0:0,rot:0,userUnit:1}],savedFields:[{name:'name',kind:'text',pageIndex:0}]},changes=0
 const session=createPdfPendingSession({getContext:()=>context,onChange:()=>changes++})
 return {session,setContext:patch=>context={...context,...patch},get changes(){return changes}}
}
const mixed=[{op:'setFormValue',value:{name:'name',value:'张三'}},{op:'rotatePages',pages:[1],dir:90},{op:'setMetadata',metadata:{title:'Report'}}]

test('one mixed PDF transaction is one undo and redo step with monotonically increasing generation',()=>{
 const f=fixture(),initial=f.session.read(),result=f.session.apply(mixed)
 assert.deepEqual(result.failures,[]);assert.equal(f.changes,1)
 const changed=f.session.read()
 assert.equal(changed.generation,1);assert.equal(changed.formEdits.name.value,'张三');assert.equal(changed.rotations[0],90);assert.equal(changed.metadata.title,'Report')
 assert.equal(f.session.canUndo(),true);assert.equal(f.session.canRedo(),false)
 assert.equal(f.session.undo(),true)
 assert.deepEqual({...f.session.read(),generation:initial.generation},initial)
 assert.equal(f.session.read().generation,2);assert.equal(f.session.canRedo(),true)
 assert.equal(f.session.redo(),true)
 assert.deepEqual({...f.session.read(),generation:changed.generation},changed)
 assert.equal(f.session.read().generation,3);assert.equal(f.changes,3)
})

test('failed and dry-run PDF batches never change history, generation, callbacks or snapshot identity',()=>{
 const f=fixture(),initial=f.session.read()
 const failed=f.session.apply([...mixed,{op:'setFormValue',value:{name:'missing',value:'bad'}}])
 assert.ok(failed.failures.length);assert.equal(f.session.read(),initial);assert.equal(f.changes,0);assert.equal(f.session.canUndo(),false)
 const dry=f.session.apply(mixed,{dryRun:true})
 assert.deepEqual(dry.failures,[]);assert.equal(f.session.read(),initial);assert.equal(f.changes,0);assert.equal(f.session.canUndo(),false)
 const abort=new AbortController();abort.abort()
 assert.throws(()=>f.session.apply(mixed,{signal:abort.signal}),{name:'AbortError'})
 assert.equal(f.session.read(),initial);assert.equal(f.changes,0)
})

test('new PDF changes after undo invalidate redo while exposed snapshots remain immutable',()=>{
 const f=fixture();f.session.apply(mixed);f.session.undo()
 f.session.apply([{op:'setMetadata',metadata:{author:'Alice'}}])
 assert.equal(f.session.canRedo(),false);assert.equal(f.session.redo(),false)
 const current=f.session.read()
 assert.throws(()=>{current.metadata.author='Changed'},TypeError)
 assert.throws(()=>{current.deleted.push(1)},TypeError)
 assert.equal(f.session.read().metadata.author,'Alice')
})

test('stale revisions and read-only context cannot mutate or replay PDF pending history',()=>{
 const f=fixture();f.session.apply(mixed)
 const before=f.session.read(),changes=f.changes
 f.setContext({baseRevision:'r2'})
 assert.throws(()=>f.session.undo(),/版本/)
 assert.throws(()=>f.session.apply(mixed),/版本/)
 assert.equal(f.session.read(),before);assert.equal(f.changes,changes)
 f.session.discard()
 assert.equal(f.session.read().baseRevision,'r2');assert.equal(f.session.read().generation,2)
 assert.equal(f.session.canUndo(),false);assert.equal(f.session.canRedo(),false);assert.deepEqual(f.session.read().formEdits,{})
 f.setContext({readOnly:true});assert.throws(()=>f.session.apply(mixed),/只读/);assert.throws(()=>f.session.undo(),/只读/)
})

test('closed PDF sessions reject edits and replay without invoking callbacks',()=>{
 const f=fixture();f.session.apply(mixed);const changes=f.changes
 f.session.dispose()
 for(const work of [()=>f.session.apply(mixed),()=>f.session.undo(),()=>f.session.redo(),()=>f.session.discard()])assert.throws(work,/关闭/)
 assert.equal(f.changes,changes)
})
