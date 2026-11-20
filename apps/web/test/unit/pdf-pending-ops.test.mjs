import test from 'node:test'
import assert from 'node:assert/strict'
import {createEmptyPdfPendingSnapshot,planPdfPendingOps} from '../../src/editors/pdf-pending-ops.ts'
const context=()=>({fileId:'file',baseRevision:'r1',generation:0,pageGeometries:Array.from({length:3},()=>({pw:300,ph:400,rot:0})),savedFields:[{name:'text',kind:'text',pageIndex:0,maxLen:10},{name:'check',kind:'checkbox',pageIndex:1},{name:'choice',kind:'choice',pageIndex:0,options:['one','two']},{name:'radio',kind:'radio',pageIndex:0,options:['old']},{name:'locked',kind:'text',pageIndex:0,readOnly:true},{name:'signature',kind:'signature',pageIndex:0}]})
const field=(name='new',extra={})=>({op:'addFormField',field:{name,kind:'text',page:1,x:10,y:20,width:100,height:30,...extra}})
function fixture(){const ctx=context(),s=createEmptyPdfPendingSnapshot(ctx);return {ctx,s:{...s,markups:[{id:'Pmark',pageIndex:0,type:'highlight',color:[1,1,0],quads:[[0,10,10,10,0,0,10,0]]}],notes:[{id:'Pnote',input:{kind:'note',pageIndex:0,rect:[1,2,20,30],contents:'old',author:'AI'}}],textInserts:[{id:'Ttext',input:{pageIndex:0,origin:[10,20],text:'keep',fontSize:12,color:[0,0,0]}}]}}}
const plan=(s,ops,ctx)=>planPdfPendingOps(s,ops,ctx)
const value=(name,v)=>({op:'setFormValue',value:{name,value:v}})
const failure=(s,ops,ctx)=>{const result=plan(s,ops,ctx);assert.equal(result.next,s);assert.ok(result.failures.length);assert.equal(result.touched.length,0);return result}
test('reduces all nine canonical operations atomically with last form value winning and original page identities',()=>{
 const {s,ctx}=fixture(),original=structuredClone(s),ops=[{op:'removeMarkup',id:'Pmark'},{op:'setNoteContents',id:'Pnote',contents:'new'},{op:'removeTextInsert',id:'Ttext'},value('text','first'),value('text','last'),field(),{op:'rotatePages',pages:[1],dir:90},{op:'deletePage',page:3},{op:'setPageOrder',order:[2,1]},{op:'setMetadata',metadata:{title:'Title'}}]
 const r=plan(s,ops,ctx);assert.deepEqual(r.failures,[]);assert.notEqual(r.next,s);assert.equal(r.next.generation,1);assert.deepEqual(s,original)
 assert.equal(r.next.markups.length,0);assert.equal(r.next.notes[0].input.contents,'new');assert.equal(r.next.textInserts.length,0);assert.equal(r.next.formEdits.text.value,'last');assert.equal(r.next.formEdits.text.kind,'text')
 assert.deepEqual(r.next.deleted,[2]);assert.deepEqual(r.next.order,[1,0,2]);assert.equal(r.next.rotations[0],90);assert.equal(r.next.metadata.title,'Title');assert.deepEqual(r.next.formFields[0].input.rect,[10,350,110,380]);assert.ok(r.touched.includes('formEdits'));assert.equal(r.focusPage,1)
})
test('invalid final operation leaves every bucket and generation unchanged',()=>{
 const {s,ctx}=fixture(),before=structuredClone(s)
 failure(s,[{op:'removeTextInsert',id:'Ttext'},value('text','okay'),{op:'rotatePages',pages:[1],dir:90},value('locked','bad')],ctx)
 assert.deepEqual(s,before)
})
test('starts from existing deleted/order/metadata/formEdits and metadata null restores saved baseline',()=>{
 const {s,ctx}=fixture(),prior={...s,deleted:[2],order:[1,0,2],metadata:{title:'pending'},formEdits:{text:{name:'text',kind:'text',value:'existing'}}}
 const r=plan(prior,[{op:'setMetadata',metadata:{author:'A'}},value('text','next'),{op:'setPageOrder',order:[2,1]}],ctx)
 assert.deepEqual(r.failures,[]);assert.deepEqual(r.next.metadata,{title:'pending',author:'A'});assert.equal(r.next.formEdits.text.value,'next');assert.deepEqual(r.next.order,[1,0,2])
 const reset=plan(r.next,[{op:'setMetadata',metadata:null},{op:'setMetadata',metadata:{subject:'S'}},{op:'setPageOrder',order:null}],{...ctx,generation:1})
 assert.deepEqual(reset.next.metadata,{subject:'S'});assert.equal(reset.next.order,null)
 failure(prior,[{op:'setPageOrder',order:[1,2,3]}],ctx);failure(prior,[{op:'rotatePages',pages:[3],dir:90}],ctx)
})
test('saved catalog infers form kinds and rejects readonly signatures invalid values and new unsaved field fills',()=>{
 const {s,ctx}=fixture()
 const r=plan(s,[{op:'setFormValue',value:{name:'check',checked:false}},value('choice','two'),value('radio',''),value('text','')],ctx)
 assert.deepEqual(r.failures,[]);assert.equal(r.next.formEdits.check.kind,'checkbox');assert.equal(r.next.formEdits.choice.kind,'choice');assert.equal(r.next.formEdits.radio.kind,'radio')
 for(const op of [value('locked','x'),value('signature','x'),value('missing','x'),value('choice','bad'),value('text','12345678901'),value('check','x'),{op:'setFormValue',value:{name:'text',checked:true}}])failure(s,[op],ctx)
 failure(s,[field(),value('new','x')],ctx)
})
test('pending P/T missing IDs are no-ops and preserve unrelated records, while saved/wrong-prefix IDs reject all',()=>{
 const {s,ctx}=fixture(),ops=[{op:'removeMarkup',id:'Pmissing'},{op:'setNoteContents',id:'Pmissing',contents:'ignored'},{op:'removeTextInsert',id:'Tmissing'},{op:'removeTextInsert',id:'Tmissing'}]
 const r=plan(s,ops,ctx);assert.deepEqual(r.failures,[]);for(const key of ['markups','notes','textInserts'])assert.deepEqual(r.next[key],s[key])
 for(const op of [{op:'removeMarkup',id:'S12'},{op:'removeTextInsert',id:'Pmark'},{op:'setNoteContents',id:'12R',contents:'bad'}])failure(s,[...ops,op],ctx)
 const wrongBucket=plan(s,[{op:'setNoteContents',id:'Pmark',contents:'ignored'},{op:'removeMarkup',id:'Pnote'}],ctx);assert.deepEqual(wrongBucket.next.notes,s.notes);assert.deepEqual(wrongBucket.next.markups,s.markups)
})
test('field names and radio export options include saved and previously authored session fields',()=>{
 const {s,ctx}=fixture(),radio=exportValue=>field('radio',{kind:'radio',exportValue,width:20,height:20})
 const r=plan(s,[radio('new'),radio('third')],ctx);assert.deepEqual(r.failures,[]);assert.equal(r.next.formFields.length,2)
 failure(s,[radio('old')],ctx);failure(s,[field('text')],ctx);failure(s,[field('x'),field('x')],ctx);failure(s,[field('radio')],ctx)
 failure(r.next,[radio('new')],{...ctx,generation:1});failure(s,[radio(undefined)],ctx)
 failure(s,[radio('new')],{...ctx,savedFields:ctx.savedFields.map(f=>f.name==='radio'?{...f,readOnly:true}:f)})
 const pending=plan(s,[field('newRadio',{kind:'radio',exportValue:'one',width:20,height:20})],ctx)
 assert.deepEqual(plan(pending.next,[field('newRadio',{kind:'radio',exportValue:'two',width:20,height:20})],{...ctx,generation:1}).failures,[])
})
test('field geometry uses batch-start pending rotation and PC CropBox/UserUnit transform',()=>{
 const {s,ctx}=fixture(),before={...s,rotations:{0:90}},c={...ctx,pageGeometries:[{pw:600,ph:800,rot:0,x0:40,y0:60,userUnit:2},...ctx.pageGeometries.slice(1)]}
 const r=plan(before,[{op:'rotatePages',pages:[1],dir:90},field('placed',{x:24,y:36,width:120,height:40,fontSize:12})],c)
 assert.deepEqual(r.failures,[]);assert.equal(r.next.rotations[0],180);assert.deepEqual(r.next.formFields[0].input.rect,[58,72,78,132]);assert.equal(r.next.formFields[0].input.fontSize,12)
 failure(s,[field('outside',{x:290,width:30})],ctx)
})
test('delete cleanup matches PC buckets and subsequent deleted-page access fails without renumbering',()=>{
 const {s,ctx}=fixture(),withField=plan(s,[field()],ctx).next,c={...ctx,generation:1}
 const r=plan(withField,[{op:'deletePage',page:1},{op:'rotatePages',pages:[2],dir:-90}],c)
 assert.deepEqual(r.failures,[]);assert.deepEqual(r.next.deleted,[0]);assert.equal(r.next.markups.length,0);assert.equal(r.next.notes.length,0);assert.equal(r.next.formFields.length,0);assert.equal(r.next.textInserts.length,1);assert.equal(r.next.rotations[1],270)
 failure(withField,[{op:'deletePage',page:1},field('late')],c)
 failure({...s,deleted:[0,1]},[{op:'deletePage',page:3}],ctx)
})
test('stale file revision generation, readonly and invalid contract input return original snapshot',()=>{
 const {s,ctx}=fixture()
 for(const patch of [{fileId:'other'},{baseRevision:'r2'},{generation:1},{readOnly:true},{pageGeometries:[]}])failure(s,[{op:'removeTextInsert',id:'Ttext'}],{...ctx,...patch})
 let invoked=false;const getter={op:'removeTextInsert'};Object.defineProperty(getter,'id',{enumerable:true,get(){invoked=true;return 'Ttext'}})
 for(const ops of [[getter],[],Array.from({length:51},()=>({op:'removeTextInsert',id:'Ttext'}))])failure(s,ops,ctx)
 assert.equal(invoked,false)
})
test('dry run preserves exact snapshot and successful state is detached deeply frozen data',()=>{
 const {s,ctx}=fixture(),r=plan(s,[value('text','ok'),field()],{...ctx,dryRun:true});assert.equal(r.next,s);assert.deepEqual(r.failures,[]);assert.ok(r.touched.length)
 const done=plan(s,[value('text','ok'),field()],ctx)
 const walk=v=>{if(v&&typeof v==='object'){assert.ok(Object.isFrozen(v));for(const child of Object.values(v))walk(child)}};walk(done.next)
 assert.equal(Object.isFrozen(s),false);assert.notEqual(done.next.notes,s.notes);assert.notEqual(done.next.notes[0].input,s.notes[0].input)
 assert.equal(Object.hasOwn(done.next,'history'),false);assert.equal(done.next.fileId,s.fileId);assert.equal(done.next.baseRevision,s.baseRevision)
})

test('rotations accumulate and cancel like PC without renumbering existing image edits',()=>{
 const {s,ctx}=fixture(),image={id:'I1',input:{kind:'insertImage',pageIndex:0,rect:[10,20,40,60],image:'png'}}
 const r=plan({...s,imageEdits:[image],rotations:{0:90}},[{op:'rotatePages',pages:[1],dir:-90},{op:'rotatePages',pages:[2],dir:180}],ctx)
 assert.deepEqual(r.failures,[]);assert.equal(Object.hasOwn(r.next.rotations,0),false);assert.equal(r.next.rotations[1],180);assert.deepEqual(r.next.imageEdits,[image])
})
test('PC geometry transform covers all rotations and small or empty authored field structures reject atomically',()=>{
 const {s,ctx}=fixture(),rects=[[10,350,110,380],[20,10,50,110],[190,20,290,50],[250,290,280,390]]
 for(const [i,rotation]of [0,90,180,270].entries()){
  const c={...ctx,pageGeometries:[{pw:300,ph:400,rot:rotation},...ctx.pageGeometries.slice(1)]}
  const r=plan(s,[field()],c);assert.deepEqual(r.failures,[]);assert.deepEqual(r.next.formFields[0].input.rect,rects[i])
 }
 for(const op of [field('a.b'),field('a/b'),field('small',{width:0.5}),field('empty',{kind:'choice',options:[]})])failure(s,[op],ctx)
})
test('multiple session radio buttons and later metadata updates preserve input values and state isolation',()=>{
 const {s,ctx}=fixture(),before=structuredClone(s)
 const r=plan(s,[field('pick',{kind:'radio',exportValue:'one',width:20,height:20}),field('pick',{kind:'radio',exportValue:'two',width:20,height:20}),{op:'setMetadata',metadata:{title:'first',author:'A'}},{op:'setMetadata',metadata:{title:''}}],ctx)
 assert.deepEqual(r.failures,[]);assert.deepEqual(r.next.formFields.map(f=>f.input.exportValue),['one','two']);assert.deepEqual(r.next.metadata,{title:'',author:'A'});assert.deepEqual(s,before)
})
