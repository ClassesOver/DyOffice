import test from 'node:test'
import assert from 'node:assert/strict'
import {createPdfPendingSession} from '../../src/editors/pdf-pending-session.ts'

const markup=()=>({id:'Pmark',pageIndex:0,type:'highlight',color:[1,1,0],quads:[[20,80,80,80,20,60,80,60]]})
const note=()=>({id:'Pnote',input:{kind:'note',pageIndex:0,color:[1,1,0],at:[100,120],contents:'Comment'}})
function fixture(){let context={fileId:'pdf',baseRevision:'r1',pageGeometries:[{pw:500,ph:600,x0:10,y0:20,rot:0,userUnit:1},{pw:500,ph:600,x0:0,y0:0,rot:90,userUnit:2}],savedFields:[]},changes=0;const session=createPdfPendingSession({getContext:()=>context,onChange:()=>changes++});return {session,setContext:patch=>context={...context,...patch},get changes(){return changes}}}

test('prepared annotations append atomically as one immutable session undo step',()=>{
 const f=fixture(),token=f.session.read(),prepared={markups:[markup()],notes:[note()]}
 f.session.appendAnnotations(prepared,token)
 assert.equal(f.changes,1);assert.equal(f.session.read().generation,1);assert.equal(f.session.read().markups.length,1);assert.equal(f.session.read().notes.length,1)
 prepared.markups[0].quads[0][0]=99;assert.equal(f.session.read().markups[0].quads[0][0],20)
 assert.throws(()=>{f.session.read().notes[0].input.at.push(1)},TypeError)
 f.session.undo();assert.equal(f.session.read().markups.length,0);assert.equal(f.session.read().notes.length,0);assert.equal(f.session.canUndo(),false)
 f.session.redo();assert.equal(f.session.read().markups.length,1);assert.equal(f.session.read().notes.length,1)
})

test('invalid geometry IDs counts or deleted pages never partially append annotations',()=>{
 for(const invalid of [
  {markups:[{...markup(),quads:[[0,80,80,80,0,60,80,60]]}],notes:[note()]},
  {markups:[{...markup(),quads:[[20,80,20,80,20,80,20,80]]}],notes:[]},
  {markups:[{...markup(),color:[1,2,0]}],notes:[]},
  {markups:[{...markup(),pageIndex:2}],notes:[]},
  {markups:[markup()],notes:[{...note(),id:'Pmark'}]},
  {markups:[markup()],notes:[{...note(),input:{...note().input,contents:''}}]},
  {markups:[],notes:[]},
  {markups:Array.from({length:101},(_,i)=>({...markup(),id:'P'+i})),notes:[]},
 ]){const f=fixture(),before=f.session.read();assert.throws(()=>f.session.appendAnnotations(invalid,before),/批注/);assert.equal(f.session.read(),before);assert.equal(f.session.canUndo(),false);assert.equal(f.changes,0)}
 const f=fixture();f.session.apply([{op:'deletePage',page:1}]);const before=f.session.read();assert.throws(()=>f.session.appendAnnotations({markups:[markup()],notes:[]},before));assert.equal(f.session.read(),before)
})

test('prepared appends reject stale ABA tokens read-only contexts and disposed sessions',()=>{
 const f=fixture(),token=f.session.read(),prepared={markups:[markup()],notes:[]};f.session.apply([{op:'setMetadata',metadata:{title:'New'}}]);f.session.undo()
 assert.throws(()=>f.session.appendAnnotations(prepared,token));assert.equal(f.session.read().markups.length,0)
 f.setContext({readOnly:true});assert.throws(()=>f.session.appendAnnotations(prepared,f.session.read()),/只读/)
 f.setContext({readOnly:false,baseRevision:'r2'});assert.throws(()=>f.session.appendAnnotations(prepared,f.session.read()),/版本/)
 f.setContext({baseRevision:'r1'});f.session.dispose();assert.throws(()=>f.session.appendAnnotations(prepared,f.session.read()),/关闭/)
})

async function controller(f,request,isReady=()=>true){const {createPdfAnnotationDrafts}=await import('../../src/editors/pdf-annotation-drafts.ts');return createPdfAnnotationDrafts({session:f.session,request,isReady})}
const operations=[{page:1,type:'highlight',text:'Original',occurrence:1},{page:1,type:'note',text:'Original',contents:'Comment',occurrence:1}]
const report=()=>({revision:'r1',markups:[(({id,...rest})=>rest)(markup())],notes:[note().input]})

test('query prepares native annotation coordinates and appends only one history item without saving',async()=>{
 const f=fixture(),calls=[],drafts=await controller(f,async(...args)=>{calls.push(args);assert.equal(f.session.canUndo(),false);return report()})
 const result=await drafts.append(operations)
 assert.equal(calls.length,1);assert.equal(calls[0][0],'/api/v1/files/pdf/pdf/annotations/query');assert.equal(calls[0][1],'POST');assert.deepEqual(calls[0][2],{revision:'r1',operations})
 assert.equal(result.markups.length,1);assert.match(result.markups[0].id,/^P/);assert.match(result.notes[0].id,/^P/);assert.notEqual(result.markups[0].id,result.notes[0].id)
 assert.equal(f.changes,1);f.session.undo();assert.equal(f.session.canUndo(),false);assert.equal(f.session.read().notes.length,0)
})

test('failed canceled stale not-ready and disposed queries never append or create history',async()=>{
 for(const mode of ['failed','cancel','stale','ready','dispose','revision','count','geometry']){
  const f=fixture(),abort=new AbortController();let resolve,reject,ready=true;const pending=new Promise((a,b)=>{resolve=a;reject=b}),drafts=await controller(f,()=>pending,()=>ready),work=drafts.append(operations,abort.signal)
  if(mode==='failed')reject(Error('Offline'))
  else {if(mode==='cancel')abort.abort();if(mode==='stale')f.session.apply([{op:'setMetadata',metadata:{title:'Elsewhere'}}]);if(mode==='ready')ready=false;if(mode==='dispose')drafts.dispose();const response=report();if(mode==='revision')response.revision='r2';if(mode==='count')response.notes=[];if(mode==='geometry')response.notes[0].at=[NaN,100];resolve(response)}
  await assert.rejects(work);assert.equal(f.session.read().markups.length,0);assert.equal(f.session.read().notes.length,0);assert.equal(f.session.canUndo(),mode==='stale');assert.equal(f.changes,mode==='stale'?1:0)
 }
})

test('newer concurrent annotation query invalidates an older response',async()=>{
 const f=fixture(),pending=[],drafts=await controller(f,()=>new Promise(resolve=>pending.push(resolve))),first=drafts.append(operations),second=drafts.append(operations)
 pending[0](report());await assert.rejects(first);assert.equal(f.session.canUndo(),false)
 pending[1](report());await second;assert.equal(f.changes,1)
})


test('annotation bounds use raw PDF coordinates with CropBox offsets and UserUnit independent of rotation',()=>{
 const f=fixture(),before=f.session.read()
 assert.throws(()=>f.session.appendAnnotations({markups:[],notes:[{...note(),input:{...note().input,pageIndex:1,at:[400,100]}}]},before),/批注/)
 assert.equal(f.session.read(),before)
 f.session.appendAnnotations({markups:[],notes:[{...note(),input:{...note().input,pageIndex:1,at:[250,300]}}]},before)
 assert.deepEqual(f.session.read().notes[0].input.at,[250,300])
 const smaller=fixture();smaller.setContext({pageGeometries:[{pw:250,ph:300,x0:10,y0:20,rot:270,userUnit:0.5}]});smaller.session.appendAnnotations({markups:[],notes:[{...note(),input:{...note().input,at:[510,620]}}]},smaller.session.read());assert.deepEqual(smaller.session.read().notes[0].input.at,[510,620])
})
