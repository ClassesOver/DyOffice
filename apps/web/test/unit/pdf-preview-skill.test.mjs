import test from 'node:test'
import assert from 'node:assert/strict'
import {createPdfPreviewSkill,searchPdfPreview,scrollPdfPreviewToPage} from '../../src/shell/pdf-preview-skill.ts'
import {createPdfTextDrafts} from '../../src/editors/pdf-text-drafts.ts'
import {createPdfPendingSession} from '../../src/editors/pdf-pending-session.ts'

const pages=[{page:1,text:'Revenue rose 10%.'},{page:2,text:'Costs fell 3%.'}]
const call=(name,input)=>({id:'t1',name,input})

function pendingSkill(pending,legacy={}){
 const args=[()=>[{...pages[0],annotations:[{id:'12R',type:'Text',author:'Saved',contents:'Original'}]},pages[1]],()=>true,...Array(23).fill(undefined)]
 Object.assign(args,legacy);args[24]={pending};return createPdfPreviewSkill(...args)
}
test('canonical pending apply_ops exposes exactly nine operations and delegates mixed batches once without saving',async()=>{
 const calls=[],signal=new AbortController().signal
 const pending={apply:async(ops,options)=>{calls.push([ops,options]);return {next:{},touched:['metadata'],focusPage:1,failures:[]}}}
 const skill=pendingSkill(pending,{8:async()=>assert.fail('legacy page writer'),13:async()=>assert.fail('legacy form writer'),23:async()=>assert.fail('legacy field writer')})
 const tool=skill.tools.find(t=>t.name==='apply_ops'),ops=[{op:'removeMarkup',id:'Pmark'},{op:'setNoteContents',id:'Pnote',contents:'New'},{op:'removeTextInsert',id:'Ttext'},{op:'setFormValue',value:{name:'field',value:'Filled'}},{op:'addFormField',field:{name:'new',kind:'text',page:1,x:10,y:20,width:100,height:20}},{op:'rotatePages',pages:[1],dir:90},{op:'deletePage',page:2},{op:'setPageOrder',order:[1]},{op:'setMetadata',metadata:{title:'Title'}}]
 assert.deepEqual(tool.inputSchema.properties.ops.items.oneOf.map(item=>item.properties.op.const).sort(),ops.map(op=>op.op).sort())
 const idPattern=new RegExp(tool.inputSchema.properties.ops.items.oneOf[0].properties.id.pattern);assert.equal(idPattern.test('Pnote'),true);assert.equal(idPattern.test('P spaces'),false)
 assert.match(tool.description,/unsaved/i);assert.doesNotMatch(skill.systemPrompt,/homogeneous|Each successful mutation saves/)
 const result=await skill.executeTool(call('apply_ops',{ops}),signal)
 assert.equal(result.mutated,true);assert.equal(result.isError,undefined);assert.match(result.output,/unsaved/i);assert.doesNotMatch(result.output,/saved a|new revision/)
 assert.equal(calls.length,1);assert.deepEqual(JSON.parse(JSON.stringify(calls[0][0])),ops);assert.deepEqual(calls[0][1],{dryRun:false,signal})
 const dry=await skill.executeTool(call('apply_ops',{ops,dry_run:true}),signal)
 assert.equal(dry.mutated,false);assert.equal(calls.length,2);assert.equal(calls[1][1].dryRun,true)
 for(const input of [{ops:[{op:'insertBlankPage',afterPage:0}]},{ops,dry_run:'yes'},{ops,extra:true}])assert.equal((await skill.executeTool(call('apply_ops',input))).isError,true)
 assert.equal(calls.length,2)
 pending.apply=async()=>({failures:[{index:1,error:'Invalid field'}]})
 const failure=await skill.executeTool(call('apply_ops',{ops}));assert.equal(failure.isError,true);assert.equal(failure.mutated,false);assert.match(failure.output,/Nothing was applied/);assert.doesNotMatch(failure.output,/saved/i)
 pending.apply=async()=>{throw Error('Unavailable')}
 assert.equal((await skill.executeTool(call('apply_ops',{ops}))).isError,true)
})
test('canonical pending adapter keeps a real session atomic across dry runs failures and undo',async()=>{
 const session=createPdfPendingSession({getContext:()=>({fileId:'file',baseRevision:'r1',pageGeometries:pages.map(()=>({pw:300,ph:400,rot:0})),savedFields:[{name:'saved',kind:'text',pageIndex:0}]}),onChange(){}})
 const skill=pendingSkill({apply:(ops,options)=>session.apply(ops,options),annotations:()=>session.read()})
 const before=session.read(),ops=[{op:'setFormValue',value:{name:'saved',value:'New'}},{op:'rotatePages',pages:[1],dir:90},{op:'setMetadata',metadata:{title:'Pending'}}]
 assert.equal((await skill.executeTool(call('apply_ops',{ops,dry_run:true}))).mutated,false);assert.equal(session.read(),before);assert.equal(session.canUndo(),false)
 const bad=await skill.executeTool(call('apply_ops',{ops:[...ops,{op:'setFormValue',value:{name:'missing',value:'Bad'}}]}))
 assert.equal(bad.isError,true);assert.equal(session.read(),before);assert.equal(session.canUndo(),false)
 assert.equal((await skill.executeTool(call('apply_ops',{ops}))).mutated,true);assert.equal(session.read().generation,1);assert.equal(session.read().formEdits.saved.value,'New');assert.equal(session.read().rotations[0],90)
 session.undo();assert.equal(session.read().metadata,null);assert.deepEqual(session.read().formEdits,{});assert.equal(session.canUndo(),false)
})
test('pending annotation creation returns P IDs and reading merges sources without changing saved IDs',async()=>{
 const calls=[],pending={apply:()=>({failures:[]}),annotate:async(a,signal)=>{calls.push([a,signal]);return {markups:[{id:'Pnew',pageIndex:0}],notes:[]}},annotations:()=>({markups:[{id:'Pmark',pageIndex:0,type:'highlight',color:[1,1,0],quads:[]}],notes:[{id:'Pnote',input:{kind:'note',pageIndex:0,contents:'Pending note',author:'AI Assistant'}}],deleted:[]})}
 const skill=pendingSkill(pending,{5:async()=>assert.fail('legacy annotate'),6:async()=>assert.fail('legacy delete'),7:async()=>assert.fail('legacy note update')})
 const signal=new AbortController().signal,result=await skill.executeTool(call('markup_text',{page:1,text:'Revenue',type:'highlight'}),signal)
 assert.equal(result.mutated,true);assert.match(result.output,/Pnew/);assert.match(result.output,/unsaved/i);assert.doesNotMatch(result.output,/saved a|new revision/);assert.equal(calls.length,1);assert.equal(calls[0][1],signal)
 const read=await skill.executeTool(call('read_annotations',{}));assert.match(read.output,/12R.*saved|saved.*12R/);assert.match(read.output,/Pmark.*pending|pending.*Pmark/);assert.match(read.output,/Pnote.*Pending note/)
 const page2=await skill.executeTool(call('read_annotations',{page:2}));assert.doesNotMatch(page2.output,/Pmark|12R/)
 for(const [name,input]of [['delete_markup',{page:1,markup_ids:['Pmark']}],['delete_note',{page:1,note_id:'Pnote'}],['edit_note',{page:1,note_id:'Pnote',text:'Changed'}]]){const result=await skill.executeTool(call(name,input));assert.equal(result.isError,true);assert.equal(result.mutated,false)}
 const missing=pendingSkill({apply:pending.apply},{5:async()=>assert.fail('legacy annotate')});assert.ok(!missing.tools.some(t=>t.name==='markup_text'||t.name==='add_note'))
 pending.annotate=async()=>{throw Error('No anchor')};const failure=await skill.executeTool(call('add_note',{page:1,anchor_text:'Revenue',contents:'Check'}));assert.equal(failure.isError,true);assert.equal(failure.mutated,false)
})

test('PDF apply_ops authors real form fields only through an offered writer and rejects mixed batches atomically',async()=>{
 const calls=[],args=[()=>pages,()=>true,...Array(22).fill(undefined)]
 args[23]=async(operations,signal)=>{calls.push([operations,signal]);return true}
 const skill=createPdfPreviewSkill(...args),signal=new AbortController().signal
 assert.match(skill.tools.find(tool=>tool.name==='apply_ops')?.description??'',/addFormField/)
 const operations=[{op:'addFormField',field:{name:'Reviewer',kind:'text',page:1,x:40,y:80,width:180,height:24,value:'张三'}}]
 const result=await skill.executeTool(call('apply_ops',{ops:operations}),signal)
 assert.equal(result.mutated,true);assert.match(result.output,/saved/i);assert.deepEqual(calls,[[operations,signal]])
 assert.equal((await skill.executeTool(call('apply_ops',{ops:operations,dry_run:true}))).mutated,false);assert.equal(calls.length,1)
 for(const ops of [[...operations,{op:'deletePage',page:2}],[...operations,{op:'setFormValue',value:{name:'Reviewer',value:'Wrong'}}],[{op:'addFormField',field:{...operations[0].field,page:3}}],[{op:'addFormField',field:{...operations[0].field,width:0}}]]){
  assert.equal((await skill.executeTool(call('apply_ops',{ops}))).isError,true)
 }
 assert.equal(calls.length,1)
 args[23]=async()=>false
 assert.equal((await createPdfPreviewSkill(...args).executeTool(call('apply_ops',{ops:operations}))).isError,true)
 const missing=createPdfPreviewSkill(()=>pages,()=>true)
 assert.ok(!missing.tools.some(tool=>tool.name==='apply_ops'))
})

test('PDF apply_ops offers metadata patches and delegates validated atomic page/property batches',async()=>{
 const calls=[],args=[()=>pages,()=>true,...Array(7).fill(undefined)]
 args[8]=async operations=>{calls.push(operations);return true}
 const skill=createPdfPreviewSkill(...args)
 assert.match(skill.tools.find(tool=>tool.name==='apply_ops').description,/setMetadata/)
 const operations=[{op:'setMetadata',metadata:{title:' Report ',author:''}},{op:'rotatePages',pages:[2],dir:90}]
 const result=await skill.executeTool(call('apply_ops',{ops:operations}))
 assert.equal(result.isError,undefined);assert.equal(result.mutated,true);assert.equal(calls.length,1)
 assert.deepEqual(calls[0],[{op:'setMetadata',metadata:{title:'Report',author:''}},operations[1]])
 const dry=await skill.executeTool(call('apply_ops',{ops:[{op:'setMetadata',metadata:null}],dry_run:true}))
 assert.equal(dry.mutated,false);assert.equal(calls.length,1)
 for(const ops of [[{op:'setMetadata',metadata:{producer:'bad'}}],[operations[0],{op:'deletePage',page:99}],[{op:'setMetadata',metadata:{title:12}}]]){
  const failed=await skill.executeTool(call('apply_ops',{ops}));assert.equal(failed.isError,true);assert.equal(failed.mutated,false)
 }
 assert.equal(calls.length,1)
})

function draftSkill(drafts,saved=async()=>assert.fail('Draft insertion must not save a revision')){
 const args=[()=>pages,()=>true,...Array(19).fill(undefined),drafts]
 args[14]=saved
 return createPdfPreviewSkill(...args)
}

test('PDF canonical removeTextInsert validates pending targets and uses one unsaved undo step',async()=>{
 let requests=0
 const drafts=createPdfTextDrafts({fileId:'pdf',getRevision:()=> 'r1',isReady:()=>true,onChange:()=>{},request:async(_path,_method,body)=>{
  requests++
  return {revision:body.revision,blocks:body.operations.map(op=>({page:op.page,text:op.text,x:10,y:20,width:80,height:20,font_size:12,color:'#000000',align:'left'}))}
 }})
 const first=await drafts.insert({page:1,text:'First'}),second=await drafts.insert({page:2,text:'Second'}),before=drafts.list(),skill=draftSkill(drafts)
 assert.match(skill.tools.find(tool=>tool.name==='apply_ops')?.description??'',/removeTextInsert/)
 const schema=skill.tools.find(tool=>tool.name==='apply_ops').inputSchema.properties.ops.items.description
 assert.match(schema,/removeTextInsert/);assert.doesNotMatch(schema,/rotatePages|setMetadata/)
 const ops=[{op:'removeTextInsert',id:first.id},{op:'removeTextInsert',id:second.id},{op:'removeTextInsert',id:first.id},{op:'removeTextInsert',id:'Tmissing'}]
 const dry=await skill.executeTool(call('apply_ops',{ops,dry_run:true}))
 assert.equal(dry.isError,undefined);assert.equal(dry.mutated,false);assert.deepEqual(drafts.list(),before);assert.equal(requests,2)
 for(const input of [
  {ops:[ops[0],{op:'removeTextInsert',id:'S12R'}]},
  {ops:[ops[0],{op:'rotatePages',pages:[1],dir:90}]},
  {ops:[ops[0],{op:'removeTextInsert',id:'Pnote'}]},{ops:[ops[0]],dry_run:'true'},
  {ops:[{...ops[0],extra:1}]},{ops:[ops[0]],extra:1},
 ]){
  const result=await skill.executeTool(call('apply_ops',input))
  assert.equal(result.isError,true,JSON.stringify(input));assert.equal(result.mutated,false);assert.deepEqual(drafts.list(),before)
 }
 assert.equal(requests,2)
 const result=await skill.executeTool(call('apply_ops',{ops}))
 assert.equal(result.isError,undefined);assert.equal(result.mutated,true);assert.match(result.output,/unsaved/);assert.match(result.output,/one undo step/);assert.doesNotMatch(result.output,/Removed 4/)
 assert.deepEqual(drafts.list(),[]);assert.equal(requests,2)
 drafts.undo();assert.deepEqual(drafts.list(),before)
 const missing=draftSkill({...drafts,removeMany:undefined})
 assert.ok(!missing.tools.some(tool=>tool.name==='apply_ops'))
 assert.equal((await missing.executeTool(call('apply_ops',{ops}))).isError,true)
})

test('PDF pending text tools delegate unsaved drafts and preserve IDs until user Save',async()=>{
 const calls=[],controller=new AbortController()
 const draft={id:'T1',page:1,text:'Draft',x:10,y:20,width:80,height:14,font_size:12,color:'#000000',align:'left'}
 const drafts={list:page=>{calls.push(['list',page]);return [draft]},insert:async(input,signal)=>{calls.push(['insert',input,signal]);return draft},edit:async(input,signal)=>{calls.push(['edit',input,signal]);return {...draft,...input}},move:async(input,signal)=>{calls.push(['move',input,signal]);return draft},remove:async(id,signal)=>{await Promise.resolve();calls.push(['remove',id,signal])}}
 const skill=draftSkill(drafts)
 for(const name of ['insert_text','list_inserted_text','edit_inserted_text','move_inserted_text','delete_inserted_text']){
  const tool=skill.tools.find(tool=>tool.name===name);assert.ok(tool);assert.match(tool.description,/unsaved/i)
 }
 assert.match(skill.systemPrompt,/unsaved/);assert.doesNotMatch(skill.systemPrompt,/Each successful mutation saves/)
 const insert={page:1,text:'Draft',x:10,y:20}
 const inserted=await skill.executeTool(call('insert_text',insert),controller.signal)
 assert.equal(inserted.mutated,true);assert.match(inserted.output,/T1/);assert.match(inserted.output,/unsaved/);assert.match(inserted.output,/Save/)
 assert.deepEqual(calls.shift(),['insert',insert,controller.signal])
 const listed=await skill.executeTool(call('list_inserted_text',{page:1}))
 assert.equal(listed.mutated,false);assert.match(listed.output,/T1/);assert.match(listed.output,/unsaved/i);assert.deepEqual(calls.shift(),['list',1])
 for(const [name,method,input] of [['edit_inserted_text','edit',{id:'T1',text:'Changed',font_size:14,color:'#123456',align:'center'}],['move_inserted_text','move',{id:'T1',x:30,dy:4}]]){
  const result=await skill.executeTool(call(name,input),controller.signal)
  assert.equal(result.mutated,true);assert.match(result.output,/unsaved/);assert.deepEqual(calls.shift(),[method,input,controller.signal])
 }
 assert.equal((await skill.executeTool(call('delete_inserted_text',{id:'T1'}),controller.signal)).mutated,true)
 assert.deepEqual(calls.shift(),['remove','T1',controller.signal])
 const args=[()=>pages,()=>true,...Array(19).fill(undefined),drafts]
 assert.ok(createPdfPreviewSkill(...args).tools.some(tool=>tool.name==='insert_text'))
})

test('PDF pending text tools reject invalid inputs before invoking any draft callback',async()=>{
 const fail=()=>assert.fail('Invalid input reached draft controller')
 const skill=draftSkill({list:fail,insert:fail,edit:fail,move:fail,remove:fail})
 for(const [name,inputs] of [
  ['insert_text',[null,[],{page:1,text:'bad',x:Infinity},{page:1,text:'bad',extra:1}]],
  ['list_inserted_text',[null,[],{page:0},{page:3},{page:'1'},{extra:1}]],
  ['edit_inserted_text',[null,[],{id:''},{id:'T1'},{id:'T1',text:''},{id:'T1',text:'\u0000'},{id:'T1',font_size:0},{id:'T1',font_size:NaN},{id:'T1',font_size:undefined},{id:'T1',align:{toString:()=> 'left'}},{id:'T1',color:'red'},{id:'T1',align:'justify'},{id:'T1',text:'ok',extra:1}]],
  ['move_inserted_text',[null,[],{id:'T1'},{id:'T1',x:1,dx:2},{id:'T1',y:1,dy:2},{id:'T1',x:'1'},{id:'T1',dx:Infinity},{id:'T1',dy:100001},{id:'T1',x:1,extra:1}]],
  ['delete_inserted_text',[null,[],{id:''},{id:1},{id:'T1',page:1}]],
 ])for(const input of inputs){
  const result=await skill.executeTool(call(name,input));assert.equal(result.isError,true,`${name}: ${JSON.stringify(input)}`);assert.equal(result.mutated,false)
 }
})

test('PDF pending text callback failures remain errors without claiming saved revisions',async()=>{
 const fail=()=>{throw Error('Draft unavailable')},skill=draftSkill({list:fail,insert:async()=>fail(),edit:async()=>fail(),move:async()=>fail(),remove:async()=>fail()})
 for(const [name,input] of [['insert_text',{page:1,text:'New'}],['list_inserted_text',{}],['edit_inserted_text',{id:'T1',text:'New'}],['move_inserted_text',{id:'T1',dx:2}],['delete_inserted_text',{id:'T1'}]]){
  const result=await skill.executeTool(call(name,input));assert.equal(result.isError,true);assert.equal(result.mutated,false);assert.doesNotMatch(result.output,/saved a new revision/i)
 }
 const readonly=createPdfPreviewSkill(()=>pages,()=>true)
 for(const name of ['list_inserted_text','edit_inserted_text','move_inserted_text','delete_inserted_text']){
  assert.ok(!readonly.tools.some(tool=>tool.name===name));assert.equal((await readonly.executeTool(call(name,{id:'T1'}))).isError,true)
 }
})

test('PDF preview skill exposes only native read and navigation tools backed by the preview',async()=>{
 const visited=[]
 const skill=createPdfPreviewSkill(()=>pages,page=>{visited.push(page);return true},()=>['Results','  Revenue'])
 assert.deepEqual(skill.tools.map(tool=>tool.name),['read_pages','search_text','goto_page','get_outline','list_form_fields','find_sensitive_info','read_annotations'])
 assert.equal((await skill.executeTool(call('get_outline',{}))).output,'Results\n  Revenue')
 assert.match((await skill.executeTool(call('read_pages',{start:1,end:2}))).output,/\[Page 1\][\s\S]*\[Page 2\]/)
 assert.match((await skill.executeTool(call('search_text',{query:'costs'}))).output,/Page 2/)
 assert.deepEqual(await skill.executeTool(call('goto_page',{page:2})),{output:'Navigated to page 2.',summary:'Go to page 2',mutated:false})
 assert.deepEqual(visited,[2])
})

test('PDF preview skill rejects page ranges outside the rendered document',async()=>{
 const skill=createPdfPreviewSkill(()=>pages,()=>true)
 const result=await skill.executeTool(call('read_pages',{start:2,end:3}))
 assert.equal(result.isError,true)
})

test('PDF preview exposes rotation only when a committed writer is available',async()=>{
 const committed=[]
 const skill=createPdfPreviewSkill(()=>pages,()=>true,()=>[],async operations=>{committed.push(operations);return true})
 assert.ok(skill.tools.some(tool=>tool.name==='rotate_pages'))
 assert.match(skill.systemPrompt,/saves a new PDF version immediately/)
 const result=await skill.executeTool(call('rotate_pages',{operations:[{page:2,degrees:90}]}))
 assert.deepEqual(result,{output:'Rotated 1 page and saved a new PDF version.',summary:'Rotate PDF pages',mutated:true})
 assert.deepEqual(committed,[[{page:2,degrees:90}]])
 const bad=await skill.executeTool(call('rotate_pages',{operations:[{page:3,degrees:90}]}))
 assert.equal(bad.isError,true)
 const fullTurn=await skill.executeTool(call('rotate_pages',{operations:[{page:1,degrees:360}]}))
 assert.equal(fullTurn.isError,true)
 const failed=createPdfPreviewSkill(()=>pages,()=>true,()=>[],async()=>false)
 const failure=await failed.executeTool(call('rotate_pages',{operations:[{page:1,degrees:90}]}))
 assert.equal(failure.isError,true)
 assert.equal(failure.mutated,false)
 const readonly=createPdfPreviewSkill(()=>pages,()=>true)
 assert.equal(readonly.tools.some(tool=>tool.name==='rotate_pages'),false)
})

test('PDF preview navigation scrolls the requested rendered page into view',()=>{
 const calls=[]
 const container={querySelector(selector){assert.equal(selector,'[data-pdf-page="2"]');return {scrollIntoView(options){calls.push(options)}}}}
 assert.equal(scrollPdfPreviewToPage(container,2),true)
 assert.deepEqual(calls,[{block:'start',behavior:'smooth'}])
 assert.equal(scrollPdfPreviewToPage({querySelector:()=>null},3),false)
})

test('PDF text edits use the committed writer and do not report a failed save as a mutation',async()=>{
 const edits=[]
 const skill=createPdfPreviewSkill(()=>pages,()=>true,()=>[],undefined,async edit=>{edits.push(edit);return true})
 assert.ok(skill.tools.some(tool=>tool.name==='edit_text'))
 const result=await skill.executeTool(call('edit_text',{page:1,old_text:'Revenue',new_text:'Income'}))
 assert.equal(result.mutated,true)
 assert.deepEqual(edits,[{page:1,oldText:'Revenue',newText:'Income',occurrence:1}])
 const invalid=await skill.executeTool(call('edit_text',{page:3,old_text:'Revenue',new_text:'Income'}))
 assert.equal(invalid.isError,true)
 assert.equal(edits.length,1)
 const failed=createPdfPreviewSkill(()=>pages,()=>true,()=>[],undefined,async()=>false)
 const failure=await failed.executeTool(call('edit_text',{page:1,old_text:'Revenue',new_text:''}))
 assert.equal(failure.mutated,false)
 assert.equal(failure.isError,true)
})

test('PDF markup and sticky notes use the committed annotation writer',async()=>{
 const annotations=[]
 const skill=createPdfPreviewSkill(()=>pages,()=>true,()=>[],undefined,undefined,async annotation=>{annotations.push(annotation);return true})
 const highlight=await skill.executeTool(call('markup_text',{page:1,text:'Revenue',type:'highlight'}))
 assert.equal(highlight.mutated,true)
 const note=await skill.executeTool(call('add_note',{page:2,anchor_text:'Costs',contents:'Please verify.'}))
 assert.equal(note.mutated,true)
 assert.deepEqual(annotations,[{page:1,text:'Revenue',type:'highlight',occurrence:1},{page:2,text:'Costs',type:'note',contents:'Please verify.',occurrence:1}])
 const invalid=await skill.executeTool(call('add_note',{page:2,anchor_text:'Costs',contents:''}))
 assert.equal(invalid.isError,true)
 assert.equal(annotations.length,2)
})

test('PDF annotations can be read with their page, author and contents',async()=>{
 const skill=createPdfPreviewSkill(()=>[{page:1,text:'Body',annotations:[{id:'n1',type:'Text',author:'AI Assistant',contents:'Verify this.'}]}],()=>true)
 const result=await skill.executeTool(call('read_annotations',{}))
 assert.match(result.output,/Page 1/)
 assert.match(result.output,/AI Assistant/)
 assert.match(result.output,/Verify this/)
 assert.equal(result.mutated,false)
})

test('canceled PDF tool calls never reach a document writer',async()=>{
 let writes=0
 const write=async()=>{writes++;return true}
 const skill=createPdfPreviewSkill(()=>pages,()=>true,()=>[],write,write,write)
 const controller=new AbortController();controller.abort()
 await assert.rejects(skill.executeTool(call('edit_text',{page:1,old_text:'Revenue',new_text:'Income'}),controller.signal),{name:'AbortError'})
 assert.equal(writes,0)
})

test('PDF preview search returns matching pages and bounded excerpts',()=>{
 const results=searchPdfPreview([
  {page:1,text:'First page'},
  {page:2,text:`${'x'.repeat(140)} Needle appears here ${'y'.repeat(140)}`},
  {page:3,text:'needle appears again'},
 ],'NEEDLE')
 assert.equal(results.length,2)
 assert.equal(results[0].page,2)
 assert.ok(results[0].excerpt.length<240)
 assert.match(results[1].excerpt,/needle appears again/i)
 assert.deepEqual(searchPdfPreview(pages,'  '),[])
})

test('PDF annotation deletion only offers available writers and targets saved IDs of the requested kind',async()=>{
 const annotations=[{id:'7R',type:'Highlight',author:'',contents:''},{id:'8R',type:'Underline',author:'',contents:''},{id:'9R',type:'Text',author:'Reviewer',contents:'Review'},{id:'10R',type:'Link',author:'',contents:''},{id:'11R',type:'Text',author:'Author',contents:'Reply',replyTo:'9R'}]
 const saved=[],controller=new AbortController()
 const skill=createPdfPreviewSkill(()=>[{page:1,text:'Body',annotations}],()=>true,()=>[],undefined,undefined,undefined,async(operations,signal)=>{saved.push(operations);assert.equal(signal,controller.signal);return true})
 assert.ok(skill.tools.some(tool=>tool.name==='delete_markup'))
 assert.ok(skill.tools.some(tool=>tool.name==='delete_note'))
 assert.equal(createPdfPreviewSkill(()=>pages,()=>true).tools.some(tool=>tool.name==='delete_note'),false)
 const result=await skill.executeTool(call('delete_markup',{page:1,type:'highlight'}),controller.signal)
 assert.equal(result.mutated,true)
 assert.deepEqual(saved[0],[{page:1,annotationId:'7R'}])
 assert.equal((await skill.executeTool(call('delete_note',{page:1,note_id:'9R'}),controller.signal)).mutated,true)
 assert.deepEqual(saved[1],[{page:1,annotationId:'9R'}])
 for(const input of [{page:1,markup_ids:['missing']},{page:1,markup_ids:['9R']},{page:1,markup_ids:['7R','7R']},{page:1,markup_ids:['10R']},{page:2,markup_ids:['7R']},{page:1,type:'unknown'}]){
  assert.equal((await skill.executeTool(call('delete_markup',input),controller.signal)).isError,true)
 }
 assert.equal((await skill.executeTool(call('delete_note',{page:1,note_id:'7R'}),controller.signal)).isError,true)
 assert.equal((await skill.executeTool(call('delete_note',{page:1,note_id:'11R'}),controller.signal)).isError,true)
 assert.match((await skill.executeTool(call('read_annotations',{}))).output,/11R.*reply to 9R/)
 assert.equal(saved.length,2)
 const failed=createPdfPreviewSkill(()=>[{page:1,text:'Body',annotations}],()=>true,()=>[],undefined,undefined,undefined,async()=>false)
 const failure=await failed.executeTool(call('delete_note',{page:1,note_id:'9R'}))
 assert.equal(failure.mutated,false)
 assert.equal(failure.isError,true)
 controller.abort()
 await assert.rejects(skill.executeTool(call('delete_note',{page:1,note_id:'9R'}),controller.signal),{name:'AbortError'})
 assert.equal(saved.length,2)
})

test('PDF replies and comment edits require a writer and saved note IDs, preserving cancellation and save failures',async()=>{
 const pages=[{page:1,text:'Body',annotations:[{id:'7R',type:'Text',author:'Original author',contents:'Root'},{id:'8R',type:'Text',author:'Reply author',contents:'Reply',replyTo:'7R'},{id:'9R',type:'Highlight',author:'Mark author',contents:'Markup'}]}]
 const calls=[],controller=new AbortController()
 const skill=createPdfPreviewSkill(()=>pages,()=>true,undefined,undefined,undefined,undefined,undefined,async(operation,signal)=>{calls.push([operation,signal]);return true})
 for(const name of ['reply_note','edit_note']){
  assert.equal(createPdfPreviewSkill(()=>pages,()=>true).tools.some(tool=>tool.name===name),false)
  const tool=skill.tools.find(tool=>tool.name===name)
  assert.deepEqual(tool.inputSchema.required,['page','note_id','text'])
 }
 assert.equal((await skill.executeTool(call('reply_note',{page:1,note_id:'7R',text:'  AI reply  '}),controller.signal)).mutated,true)
 assert.equal((await skill.executeTool(call('edit_note',{page:1,note_id:'8R',text:'Edited reply'}),controller.signal)).mutated,true)
 assert.deepEqual(calls,[[{page:1,annotationId:'7R',action:'reply',text:'AI reply'},controller.signal],[{page:1,annotationId:'8R',action:'edit',text:'Edited reply'},controller.signal]])
 for(const [name,input] of [['reply_note',{page:1,note_id:'8R',text:'No nested reply'}],['edit_note',{page:1,note_id:'9R',text:'Not a note'}],['edit_note',{page:2,note_id:'7R',text:'Wrong page'}],['edit_note',{page:1,note_id:'missing',text:'Missing'}],['edit_note',{page:1,note_id:'7R',text:' '}],['edit_note',{page:1,note_id:'7R',text:'x'.repeat(4001)}]]){
  const result=await skill.executeTool(call(name,input));assert.equal(result.mutated,false);assert.equal(result.isError,true)
 }
 assert.equal(calls.length,2)
 const failed=createPdfPreviewSkill(()=>pages,()=>true,undefined,undefined,undefined,undefined,undefined,async()=>false)
 const failure=await failed.executeTool(call('edit_note',{page:1,note_id:'7R',text:'Unsaved'}))
 assert.equal(failure.mutated,false);assert.equal(failure.isError,true)
 controller.abort()
 await assert.rejects(skill.executeTool(call('reply_note',{page:1,note_id:'7R',text:'Canceled'}),controller.signal),{name:'AbortError'})
 assert.equal(calls.length,2)
 assert.match(skill.systemPrompt,/preserv.*author/i)
})

test('PDF page operations preserve PC inputs, validate dry runs atomically and save only offered writes',async()=>{
 let current=[{page:1,text:'First'},{page:2,text:'Second'},{page:3,text:'Last'}]
 const writes=[],controller=new AbortController()
 const writer=async(operations,signal)=>{writes.push([operations,signal]);return true}
 const skill=createPdfPreviewSkill(()=>current,()=>true,undefined,undefined,undefined,undefined,undefined,undefined,writer)
 assert.ok(skill.tools.some(tool=>tool.name==='apply_ops'))
 assert.ok(skill.tools.some(tool=>tool.name==='insert_blank_page'))
 assert.equal(createPdfPreviewSkill(()=>current,()=>true).tools.some(tool=>tool.name==='apply_ops'),false)
 const ops=[{op:'rotatePages',pages:[3],dir:90},{op:'deletePage',page:2},{op:'setPageOrder',order:[3,1]}]
 const dry=await skill.executeTool(call('apply_ops',{ops,dry_run:true}),controller.signal)
 assert.equal(dry.mutated,false);assert.equal(dry.isError,undefined)
 assert.match(dry.output,/not.*(protection|writab)/i);assert.equal(writes.length,0)
 const saved=await skill.executeTool(call('apply_ops',{ops}),controller.signal)
 assert.equal(saved.mutated,true);assert.match(saved.output,/re-read|read_pages/i)
 assert.deepEqual(writes[0],[ops,controller.signal])
 const blank=await skill.executeTool(call('insert_blank_page',{after_page:0}),controller.signal)
 assert.equal(blank.mutated,true)
 assert.deepEqual(writes[1],[[{op:'insertBlankPage',afterPage:0}],controller.signal])
 for(const ops of [[{op:'deletePage',page:1},{op:'deletePage',page:2},{op:'deletePage',page:3}],[{op:'deletePage',page:2},{op:'deletePage',page:2}],[{op:'setPageOrder',order:[2,2,1]}],[{op:'setMetadata',title:'Unsupported'}],[{op:'rotatePages',pages:[3],dir:45}]]){
  const result=await skill.executeTool(call('apply_ops',{ops,dry_run:true}));assert.equal(result.mutated,false);assert.equal(result.isError,true)
 }
 current=[{page:1,text:'Only surviving page'}]
 assert.equal((await skill.executeTool(call('apply_ops',{ops:[{op:'deletePage',page:1}]}))).isError,true)
 assert.equal((await skill.executeTool(call('insert_blank_page',{after_page:2}))).isError,true)
 assert.equal(writes.length,2)
 const failed=createPdfPreviewSkill(()=>current,()=>true,undefined,undefined,undefined,undefined,undefined,undefined,async()=>false)
 assert.equal((await failed.executeTool(call('insert_blank_page',{after_page:1}))).mutated,false)
 controller.abort()
 await assert.rejects(skill.executeTool(call('apply_ops',{ops:[{op:'rotatePages',pages:[1],dir:90}]}),controller.signal),{name:'AbortError'})
 assert.equal(writes.length,2)
})

test('PDF resize and crop keep PC inputs, stage canonical dimensions and never describe cropping as redaction',async()=>{
 const current=[{page:1,text:'Visible body',width:612,height:792},{page:2,text:'Other page',width:612,height:792}]
 const writes=[],controller=new AbortController()
 const skill=createPdfPreviewSkill(()=>current,()=>true,undefined,undefined,undefined,undefined,undefined,undefined,async(operations,signal)=>{writes.push([operations,signal]);return true})
 for(const name of ['set_page_size','crop_pages']){
  assert.ok(skill.tools.some(tool=>tool.name===name))
  assert.equal(createPdfPreviewSkill(()=>current,()=>true).tools.some(tool=>tool.name===name),false)
 }
 const resized=await skill.executeTool(call('set_page_size',{preset:'a4'}),controller.signal)
 assert.equal(resized.mutated,true)
 assert.deepEqual(writes[0],[[{op:'setPageSize',width:595,height:842}],controller.signal])
 assert.equal((await skill.executeTool(call('set_page_size',{width:400,height:600}),controller.signal)).mutated,true)
 assert.deepEqual(writes[1][0],[{op:'setPageSize',width:400,height:600}])
 const crop=await skill.executeTool(call('crop_pages',{pages:'2,1-2',left:0.1,top:0.2,right:0.9,bottom:1}),controller.signal)
 assert.equal(crop.mutated,true)
 assert.deepEqual(writes[2],[[{op:'cropPages',pages:[1,2],left:0.1,top:0.2,right:0.9,bottom:1}],controller.signal])
 assert.match(crop.output,/CropBox/);assert.match(crop.output,/not.*redact/i)
 assert.match(skill.tools.find(tool=>tool.name==='crop_pages').description,/not.*redact/i)
 assert.equal((await skill.executeTool(call('crop_pages',{pages:'all',left:0,top:0,right:0.5,bottom:1}))).mutated,true)
 for(const input of [{preset:'Tabloid'},{width:71,height:800},{width:400,height:Infinity},{width:400},{preset:'A4',width:400,height:600}]){
  const failure=await skill.executeTool(call('set_page_size',input));assert.equal(failure.mutated,false);assert.equal(failure.isError,true)
 }
 for(const input of [{pages:'3',left:0,top:0,right:0.5,bottom:1},{pages:'2-1',left:0,top:0,right:0.5,bottom:1},{pages:'all',left:0,top:0,right:1,bottom:1},{pages:'all',left:0.9,top:0,right:0.1,bottom:1},{pages:'all',left:-1,top:0,right:1,bottom:1}]){
  const failure=await skill.executeTool(call('crop_pages',input));assert.equal(failure.mutated,false);assert.equal(failure.isError,true)
 }
 assert.equal(writes.length,4)
 const failed=createPdfPreviewSkill(()=>current,()=>true,undefined,undefined,undefined,undefined,undefined,undefined,async()=>false)
 assert.equal((await failed.executeTool(call('set_page_size',{preset:'A4'}))).mutated,false)
 controller.abort()
 await assert.rejects(skill.executeTool(call('crop_pages',{pages:'all',left:0,top:0,right:0.5,bottom:1}),controller.signal),{name:'AbortError'})
 assert.equal(writes.length,4)
 assert.match((await skill.executeTool(call('read_pages',{start:1}))).output,/612.*792.*pt/)
})

test('PDF extraction preserves source pages, requires a creator, and reports only confirmed new files',async()=>{
 const writes=[],controller=new AbortController()
 const extract=async(pages,signal)=>{writes.push([pages,signal]);return {ok:true}}
 const skill=createPdfPreviewSkill(()=>pages,()=>true,undefined,undefined,undefined,undefined,undefined,undefined,undefined,extract)
 assert.ok(skill.tools.some(tool=>tool.name==='extract_pages'))
 assert.equal(createPdfPreviewSkill(()=>pages,()=>true).tools.some(tool=>tool.name==='extract_pages'),false)
 const result=await skill.executeTool(call('extract_pages',{pages:'2,1'}),controller.signal)
 assert.equal(result.mutated,true);assert.match(result.output,/new PDF/);assert.match(result.output,/source.*unchanged/i)
 assert.deepEqual(writes,[[[1,2],controller.signal]])
 for(const input of [{pages:'3'},{pages:''},{pages:1}]){
  const failure=await skill.executeTool(call('extract_pages',input));assert.equal(failure.mutated,false);assert.equal(failure.isError,true)
 }
 const failed=createPdfPreviewSkill(()=>pages,()=>true,undefined,undefined,undefined,undefined,undefined,undefined,undefined,async()=>({ok:false,error:'已创建，但打开失败，不要重复创建'}))
 const failure=await failed.executeTool(call('extract_pages',{pages:'1'}));assert.equal(failure.mutated,false);assert.equal(failure.isError,true);assert.match(failure.output,/已创建/)
 controller.abort()
 await assert.rejects(skill.executeTool(call('extract_pages',{pages:'1'}),controller.signal),{name:'AbortError'})
 assert.equal(writes.length,1)
})

test('PDF split uses PC pages_per_file, requires multiple outputs and preserves partial failures',async()=>{
 const writes=[],controller=new AbortController()
 const split=async(count,signal)=>{writes.push([count,signal]);return {ok:true}}
 const skill=createPdfPreviewSkill(()=>pages,()=>true,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,split)
 assert.ok(skill.tools.some(tool=>tool.name==='split_pdf'))
 assert.equal(createPdfPreviewSkill(()=>pages,()=>true).tools.some(tool=>tool.name==='split_pdf'),false)
 assert.equal((await skill.executeTool(call('split_pdf',{pages_per_file:1}),controller.signal)).mutated,true)
 assert.deepEqual(writes,[[1,controller.signal]])
 for(const count of [0,-1,1.5,'1',2,3]){
  const result=await skill.executeTool(call('split_pdf',{pages_per_file:count}));assert.equal(result.isError,true);assert.equal(result.mutated,false)
 }
 const failed=createPdfPreviewSkill(()=>pages,()=>true,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,async()=>({ok:false,error:'已生成 1/2 份，请确认保存结果，不要重复拆分。'}))
 const result=await failed.executeTool(call('split_pdf',{pages_per_file:1}))
 assert.equal(result.isError,true);assert.equal(result.mutated,false);assert.match(result.output,/1\/2/)
 controller.abort()
 await assert.rejects(skill.executeTool(call('split_pdf',{pages_per_file:1}),controller.signal),{name:'AbortError'})
 assert.equal(writes.length,1)
})

test('PDF page layout preserves PC parameters, disclosure boundaries, output limit and cancellation',async()=>{
 const writes=[],controller=new AbortController()
 let current=pages
 const layout=async(operation,signal)=>{writes.push([operation,signal]);return {ok:true}}
 const skill=createPdfPreviewSkill(()=>current,()=>true,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,layout)
 for(const name of ['split_pages','merge_pages']){
  assert.ok(skill.tools.some(tool=>tool.name===name))
  assert.equal(createPdfPreviewSkill(()=>pages,()=>true).tools.some(tool=>tool.name===name),false)
 }
 const split=await skill.executeTool(call('split_pages',{per_page:4}),controller.signal)
 assert.equal(split.mutated,true);assert.match(split.output,/MediaBox.*CropBox/);assert.match(split.output,/not redact/);assert.match(split.output,/source.*unchanged/i)
 assert.deepEqual(writes[0],[{kind:'split',perPage:4},controller.signal])
 const merge=await skill.executeTool(call('merge_pages',{per_sheet:3}),controller.signal)
 assert.equal(merge.mutated,true);assert.match(merge.output,/single.source|this PDF/i);assert.match(merge.output,/interactive annotations.*not copied/i)
 assert.deepEqual(writes[1],[{kind:'merge',perSheet:3,direction:'vertical',separator:false},controller.signal])
 assert.equal((await skill.executeTool(call('merge_pages',{per_sheet:16,direction:'horizontal',separator:true}))).mutated,true)
 assert.deepEqual(writes[2][0],{kind:'merge',perSheet:16,direction:'horizontal',separator:true})
 for(const input of [{per_page:1},{per_page:3},{per_page:4.5},{per_page:'4'}])assert.equal((await skill.executeTool(call('split_pages',input))).isError,true)
 for(const input of [{per_sheet:1},{per_sheet:17},{per_sheet:2.5},{per_sheet:'2'},{per_sheet:4,direction:'diagonal'},{per_sheet:4,separator:1},{per_sheet:4,separator:null},{per_sheet:4,direction:null}])assert.equal((await skill.executeTool(call('merge_pages',input))).isError,true)
 current=Array.from({length:25},(_,i)=>({page:i+1,text:''}))
 assert.equal((await skill.executeTool(call('split_pages',{per_page:4}))).mutated,true)
 current=Array.from({length:26},(_,i)=>({page:i+1,text:''}))
 const tooLarge=await skill.executeTool(call('split_pages',{per_page:4}));assert.equal(tooLarge.isError,true);assert.match(tooLarge.output,/100/)
 assert.equal(writes.length,4)
 const failed=createPdfPreviewSkill(()=>pages,()=>true,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,async()=>({ok:false,error:'创建结果待确认，不要重复生成'}))
 const failure=await failed.executeTool(call('merge_pages',{per_sheet:2}));assert.equal(failure.isError,true);assert.equal(failure.mutated,false);assert.match(failure.output,/待确认/)
 controller.abort()
 await assert.rejects(skill.executeTool(call('split_pages',{per_page:2}),controller.signal),{name:'AbortError'})
 assert.equal(writes.length,4)
})

test('PDF list_form_fields reads the latest native catalog without promising form writes',async()=>{
 let fields=[{name:'Customer',kind:'text',pageIndex:0,value:'Alice',checked:false,required:true,readOnly:false,options:[]},{name:'Approved',kind:'checkbox',pageIndex:1,value:'',checked:true,required:false,readOnly:false,options:[]},{name:'Region',kind:'choice',pageIndex:1,value:'EU',checked:false,required:false,readOnly:false,options:['EU','US']}]
 const skill=createPdfPreviewSkill(()=>pages,()=>true,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,()=>fields)
 const result=await skill.executeTool(call('list_form_fields',{}))
 assert.equal(result.mutated,false);assert.match(result.output,/Customer.*text.*page 1.*Alice/);assert.match(result.output,/Approved.*checkbox.*page 2.*true/);assert.match(result.output,/Region.*choice.*page 2.*EU.*US/)
 assert.match(result.output,/read.only.*fill/i)
 fields=[];assert.match((await skill.executeTool(call('list_form_fields',{}))).output,/no form fields/i)
 fields=null;const unloaded=await skill.executeTool(call('list_form_fields',{}));assert.equal(unloaded.isError,true);assert.doesNotMatch(unloaded.output,/Alice/)
})

test('PDF sensitive lookup reuses PC patterns, caps results and refuses marking or OCR claims',async()=>{
 let current=[{page:1,text:'Contact alice@example.com; SSN 123-45-6789; card 4111 1111 1111 1111; date 2026-11-19; phone +1 212 555 1234; IBAN GB82 WEST 1234 5698 7654 32'},{page:2,text:''}]
 const skill=createPdfPreviewSkill(()=>current,()=>true)
 assert.ok(skill.tools.some(tool=>tool.name==='find_sensitive_info'))
 assert.deepEqual(Object.keys(skill.tools.find(tool=>tool.name==='find_sensitive_info').inputSchema.properties),['patterns','mark'])
 const result=await skill.executeTool(call('find_sensitive_info',{}))
 assert.equal(result.mutated,false)
 for(const pattern of ['email','ssn','credit-card','date','phone','iban'])assert.match(result.output,new RegExp(`Page 1 \\[${pattern}\\]`))
 assert.match(result.output,/no OCR/i);assert.match(result.output,/without extracted text: 2/)
 const filtered=await skill.executeTool(call('find_sensitive_info',{patterns:['email']}));assert.match(filtered.output,/alice@example.com/);assert.doesNotMatch(filtered.output,/123-45-6789/)
 assert.equal((await skill.executeTool(call('find_sensitive_info',{patterns:['unknown']}))).isError,true)
 const marked=await skill.executeTool(call('find_sensitive_info',{mark:true}));assert.equal(marked.isError,true);assert.equal(marked.mutated,false);assert.match(marked.output,/mark.*unavailable|not.*mark/i)
 current=[{page:1,text:Array.from({length:70},(_,i)=>`person${i}@example.com`).join(' ')}]
 const capped=await skill.executeTool(call('find_sensitive_info',{patterns:['email']}));assert.match(capped.output,/70 hits total.*first 60/);assert.equal(capped.output.split('\n').filter(line=>line.startsWith('Page ')).length,60)
 current=[{page:1,text:''}];assert.match((await skill.executeTool(call('find_sensitive_info',{}))).output,/extracted text/)
 const controller=new AbortController();controller.abort();await assert.rejects(skill.executeTool(call('find_sensitive_info',{}),controller.signal),{name:'AbortError'})
})

test('PDF apply_ops fills a homogeneous native form batch with PC values, validates dry runs and rejects mixed edits atomically',async()=>{
 let fields=[{name:'Name',kind:'text',pageIndex:0,value:'Old',checked:false,required:false,readOnly:false,options:[]},{name:'Approved',kind:'checkbox',pageIndex:0,value:'',checked:false,required:false,readOnly:false,options:[]},{name:'Region',kind:'choice',pageIndex:0,value:'EU',checked:false,required:false,readOnly:false,options:['EU','US']},{name:'Locked',kind:'text',pageIndex:0,value:'',checked:false,required:false,readOnly:true,options:[]},{name:'Signature',kind:'signature',pageIndex:0,value:'',checked:false,required:false,readOnly:false,options:[]}]
 const writes=[],controller=new AbortController()
 const writer=async(ops,signal)=>{writes.push([ops,signal]);return true}
 const skill=createPdfPreviewSkill(()=>pages,()=>true,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,()=>fields,writer)
 assert.ok(skill.tools.some(tool=>tool.name==='apply_ops'))
 assert.match(skill.tools.find(tool=>tool.name==='apply_ops').description,/setFormValue/)
 assert.doesNotMatch(skill.systemPrompt,/form filling.*unavailable/i)
 assert.doesNotMatch(skill.systemPrompt,/read-only preview/i)
 const ops=[{op:'setFormValue',value:{name:'Name',value:'New'}},{op:'setFormValue',value:{name:'Approved',checked:true}},{op:'setFormValue',value:{name:'Region',value:'US'}}]
 const dry=await skill.executeTool(call('apply_ops',{ops,dry_run:true}),controller.signal)
 assert.equal(dry.mutated,false);assert.match(dry.output,/protection.*not.*checked|not.*protection/i);assert.equal(writes.length,0)
 assert.equal((await skill.executeTool(call('apply_ops',{ops}),controller.signal)).mutated,true)
 assert.deepEqual(writes,[[ops,controller.signal]])
 assert.equal((await skill.executeTool(call('apply_ops',{ops:[{op:'setFormValue',value:{name:'Name'}}]}))).mutated,true)
 assert.deepEqual(writes[1][0],[{op:'setFormValue',value:{name:'Name',value:''}}])
 for(const bad of [{name:'Missing',value:'x'},{name:'Locked',value:'x'},{name:'Signature',value:'x'},{name:'Name',checked:true},{name:'Name',value:1},{name:'Approved',value:'Yes'},{name:'Approved',checked:'true'},{name:'Region',value:'AU'},{name:'Name',kind:'text',value:'x'}]){
  const failed=await skill.executeTool(call('apply_ops',{ops:[ops[0],{op:'setFormValue',value:bad}]}));assert.equal(failed.isError,true);assert.equal(failed.mutated,false)
 }
 const mixed=await skill.executeTool(call('apply_ops',{ops:[ops[0],{op:'deletePage',page:2}]}));assert.equal(mixed.isError,true);assert.match(mixed.output,/mix/i)
 assert.equal(writes.length,2)
 fields=null
 assert.equal(skill.tools.some(tool=>tool.name==='apply_ops'),false)
 assert.equal((await skill.executeTool(call('apply_ops',{ops}))).isError,true)
 const noWriter=createPdfPreviewSkill(()=>pages,()=>true,undefined,undefined,undefined,undefined,undefined,undefined,async()=>{assert.fail('Form edits must not use page writer')},undefined,undefined,undefined,()=>[])
 assert.equal((await noWriter.executeTool(call('apply_ops',{ops}))).isError,true)
 controller.abort();await assert.rejects(skill.executeTool(call('apply_ops',{ops}),controller.signal),{name:'AbortError'})
})

test('PDF insertion forwards full layout options only to a saved-revision writer',async()=>{
 const writes=[]
 let saved=true
 const skill=createPdfPreviewSkill(()=>pages,()=>true,...Array(12).fill(undefined),async(input,signal)=>{writes.push([input,signal]);return saved})
 assert.ok(skill.tools.some(tool=>tool.name==='insert_text'))
 const input={page:1,text:'张三',anchor_text:'Revenue',placement:'below',max_width:150,align:'center',font:'arial',font_size:12,color:'#123456',bold:true,italic:false}
 const controller=new AbortController()
 assert.equal((await skill.executeTool(call('insert_text',input),controller.signal)).mutated,true)
 assert.deepEqual(writes,[[input,controller.signal]])
 for(const patch of [{page:3},{text:''},{font_size:NaN},{x:Infinity},{max_width:0},{align:'justify'},{placement:'left'},{color:'red'},{font:'unknown'},{bold:'true'},{unexpected:true}]){
  const result=await skill.executeTool(call('insert_text',{...input,...patch}))
  assert.equal(result.isError,true);assert.equal(result.mutated,false)
 }
 assert.equal(writes.length,1)
 saved=false
 assert.equal((await skill.executeTool(call('insert_text',{page:1,text:'hello'}))).isError,true)
 const readonly=createPdfPreviewSkill(()=>pages,()=>true)
 assert.equal((await readonly.executeTool(call('insert_text',input))).isError,true)
 controller.abort();await assert.rejects(skill.executeTool(call('insert_text',input),controller.signal),{name:'AbortError'})
})

test('PDF paragraph rewrite forwards full styles, supports deletion and never claims a rejected save',async()=>{
 const writes=[];let saved=true
 const skill=createPdfPreviewSkill(()=>pages,()=>true,...Array(13).fill(undefined),async(input,signal)=>{writes.push([input,signal]);return saved})
 assert.ok(skill.tools.some(tool=>tool.name==='edit_block'))
 const controller=new AbortController(),input={page:1,paragraph_text:'Revenue',new_text:'New paragraph',font_size:13,color:'#123456',font:'times',bold:true,italic:true,align:'center'}
 assert.equal((await skill.executeTool(call('edit_block',input),controller.signal)).mutated,true)
 assert.deepEqual(writes,[[input,controller.signal]])
 assert.equal((await skill.executeTool(call('edit_block',{page:1,paragraph_text:'Revenue',new_text:''}))).mutated,true)
 for(const patch of [{page:0},{page:3},{paragraph_text:''},{paragraph_text:' \n '},{new_text:null},{font_size:0},{font_size:Infinity},{align:'justify'},{font:'unknown'},{color:'red'},{bold:'true'},{unexpected:true}]){
  const result=await skill.executeTool(call('edit_block',{...input,...patch}));assert.equal(result.isError,true);assert.equal(result.mutated,false)
 }
 assert.equal(writes.length,2)
 saved=false;assert.equal((await skill.executeTool(call('edit_block',input))).isError,true)
 const readonly=createPdfPreviewSkill(()=>pages,()=>true)
 assert.equal((await readonly.executeTool(call('edit_block',input))).isError,true)
 controller.abort();await assert.rejects(skill.executeTool(call('edit_block',input),controller.signal),{name:'AbortError'})
})

test('PDF paragraph moves validate displayed offsets and only report confirmed saves',async()=>{
 const writes=[];let saved=true
 const skill=createPdfPreviewSkill(()=>pages,()=>true,...Array(14).fill(undefined),async(input,signal)=>{writes.push([input,signal]);return saved})
 assert.ok(skill.tools.some(tool=>tool.name==='move_text_block'))
 const controller=new AbortController(),input={page:1,paragraph_text:'Revenue',dx:20,dy:-30}
 assert.equal((await skill.executeTool(call('move_text_block',input),controller.signal)).mutated,true)
 assert.deepEqual(writes,[[input,controller.signal]])
 for(const patch of [{page:0},{page:3},{paragraph_text:''},{dx:NaN},{dy:Infinity},{dx:0,dy:0},{dx:'20'},{dx:100001},{unexpected:true}]){
  const result=await skill.executeTool(call('move_text_block',{...input,...patch}));assert.equal(result.isError,true);assert.equal(result.mutated,false)
 }
 assert.equal(writes.length,1)
 saved=false;assert.equal((await skill.executeTool(call('move_text_block',input))).isError,true)
 assert.equal((await createPdfPreviewSkill(()=>pages,()=>true).executeTool(call('move_text_block',input))).isError,true)
 controller.abort();await assert.rejects(skill.executeTool(call('move_text_block',input),controller.signal),{name:'AbortError'})
})

test('PDF image tools keep PC geometry parameters and report only confirmed mutations',async()=>{
 const reads=[],writes=[],controller=new AbortController()
 let success=true
 const images={read:async(page,signal)=>{reads.push([page,signal]);return [{page:1,image_number:1,x:10,y:20,width:100,height:50,layer:'below_text'}]},edit:async(input,signal)=>{writes.push([input,signal]);return success}}
 const skill=createPdfPreviewSkill(()=>pages,()=>true,...Array(15).fill(undefined),images)
 for(const name of ['list_page_images','transform_image','rotate_image','delete_image'])assert.ok(skill.tools.some(tool=>tool.name===name))
 const listed=await skill.executeTool(call('list_page_images',{page:1}),controller.signal)
 assert.match(listed.output,/image_number/);assert.deepEqual(reads,[[1,controller.signal]])
 const input={page:1,image_number:1,width:50,x:20,layer:'above_text'}
 assert.equal((await skill.executeTool(call('transform_image',input),controller.signal)).mutated,true)
 assert.deepEqual(writes,[[{op:'transform_image',...input},controller.signal]])
 assert.equal((await skill.executeTool(call('rotate_image',{page:1,image_number:1,direction:'ccw'}))).mutated,true)
 assert.equal((await skill.executeTool(call('delete_image',{page:1,image_number:1}))).mutated,true)
 for(const [name,bad]of [['transform_image',{...input,width:0}],['transform_image',{...input,x:Infinity}],['transform_image',{...input,layer:'front'}],['rotate_image',{page:1,image_number:1,direction:'left'}],['delete_image',{page:1,image_number:1,width:10}],['delete_image',{page:3,image_number:1}],['list_page_images',{page:0}]])assert.equal((await skill.executeTool(call(name,bad))).isError,true)
 assert.equal(writes.length,3)
 success=false;assert.equal((await skill.executeTool(call('delete_image',{page:1,image_number:1}))).mutated,false)
 controller.abort();await assert.rejects(skill.executeTool(call('delete_image',{page:1,image_number:1}),controller.signal),{name:'AbortError'})
})

test('PDF image content tools keep PC URL and placement parameters and never claim an unconfirmed save',async()=>{
 const writes=[],controller=new AbortController();let success=true
 const images={read:async()=>[],edit:async()=>false,content:async(...args)=>{writes.push(args);return success}}
 const skill=createPdfPreviewSkill(()=>pages,()=>true,...Array(15).fill(undefined),images)
 for(const name of ['insert_image','replace_image'])assert.ok(skill.tools.some(tool=>tool.name===name))
 const input={page:1,url:'https://images.example/photo.png',anchor_text:'Revenue',placement:'left',x:20,y:30,width:90,layer:'above_text'}
 assert.equal((await skill.executeTool(call('insert_image',input),controller.signal)).mutated,true)
 assert.deepEqual(writes,[[{op:'insert_image',...input},controller.signal]])
 assert.equal((await skill.executeTool(call('replace_image',{page:2,image_number:1,url:input.url}))).mutated,true)
 for(const patch of [{page:3},{url:''},{url:123},{width:0},{x:Infinity},{placement:'center'},{anchor_text:''},{layer:'front'},{image_number:1}])assert.equal((await skill.executeTool(call('insert_image',{...input,...patch}))).isError,true)
 for(const patch of [{image_number:0},{image_number:1.5},{width:20},{url:null}])assert.equal((await skill.executeTool(call('replace_image',{page:1,image_number:1,url:input.url,...patch}))).isError,true)
 assert.equal(writes.length,2)
 success=false;const failed=await skill.executeTool(call('insert_image',input));assert.equal(failed.isError,true);assert.equal(failed.mutated,false)
 const geometryOnly=createPdfPreviewSkill(()=>pages,()=>true,...Array(15).fill(undefined),{read:images.read,edit:images.edit})
 assert.equal(geometryOnly.tools.some(tool=>tool.name==='insert_image'),false)
 assert.equal((await geometryOnly.executeTool(call('insert_image',input))).isError,true)
 controller.abort();await assert.rejects(skill.executeTool(call('insert_image',input),controller.signal),{name:'AbortError'})
})

test('PDF pixel tools preserve PC arguments, reject empty crops and report only saved changes',async()=>{
 const writes=[],controller=new AbortController();let success=true
 const images={read:async()=>[],edit:async(...args)=>{writes.push(args);return success}}
 const skill=createPdfPreviewSkill(()=>pages,()=>true,...Array(15).fill(undefined),images)
 const inputs=[['flip_image',{page:1,image_number:1,axis:'horizontal'}],['set_image_opacity',{page:1,image_number:1,opacity:.4}],['crop_image',{page:1,image_number:1,left:.25,top:.1}],['remove_image_background',{page:1,image_number:1,tolerance:25}]]
 for(const [name,input] of inputs){
  assert.ok(skill.tools.some(tool=>tool.name===name),name)
  assert.equal((await skill.executeTool(call(name,input),controller.signal)).mutated,true,name)
 }
 assert.deepEqual(writes,inputs.map(([op,input])=>[{op,...input},controller.signal]))
 const invalid=[['flip_image',{axis:'h'}],['flip_image',{axis:null}],['set_image_opacity',{opacity:NaN}],['set_image_opacity',{opacity:1.1}],['set_image_opacity',{opacity:'0.5'}],['set_image_opacity',{}],['crop_image',{}],['crop_image',{left:.7,right:.3}],['crop_image',{top:.6,bottom:.5}],['crop_image',{left:-.1}],['crop_image',{top:Infinity}],['remove_image_background',{tolerance:101}],['remove_image_background',{tolerance:'20'}]]
 for(const [name,input]of invalid){const result=await skill.executeTool(call(name,{page:1,image_number:1,...input}));assert.equal(result.isError,true,JSON.stringify([name,input]));assert.equal(result.mutated,false)}
 assert.equal(writes.length,4)
 assert.equal((await skill.executeTool(call('remove_image_background',{page:1,image_number:1}))).mutated,true)
 success=false;assert.equal((await skill.executeTool(call('set_image_opacity',{page:1,image_number:1,opacity:0}))).isError,true)
 const readonly=createPdfPreviewSkill(()=>pages,()=>true);assert.equal((await readonly.executeTool(call('flip_image',inputs[0][1]))).isError,true)
 controller.abort();await assert.rejects(skill.executeTool(call('flip_image',inputs[0][1]),controller.signal),{name:'AbortError'})
 const opacity=skill.tools.find(tool=>tool.name==='set_image_opacity');assert.match(opacity.description,/current saved.*alpha/i)
})

test('image draft insertion reports unsaved I ID and never invokes immediate save, replacement stays saved',async()=>{
 const queued=[],saved=[],controller=new AbortController();let fail=false
 const images={read:async()=>[],edit:async()=>false,content:async(...args)=>{saved.push(args);return true},insertDraft:async(...args)=>{if(fail)throw Error('draft unavailable');queued.push(args);return {id:'I7',page:1,x:10,y:20,width:90,height:45}}}
 const skill=createPdfPreviewSkill(()=>pages,()=>true,...Array(15).fill(undefined),images)
 const input={page:1,url:'https://example.com/photo.png',width:90}
 const result=await skill.executeTool(call('insert_image',input),controller.signal)
 assert.equal(result.mutated,true);assert.match(result.output,/I7/);assert.match(result.output,/unsaved/i);assert.match(result.output,/user.*Save/i)
 assert.deepEqual(queued,[[{op:'insert_image',...input},controller.signal]]);assert.equal(saved.length,0)
 assert.match(skill.tools.find(tool=>tool.name==='insert_image').description,/unsaved/i)
 assert.match(skill.systemPrompt,/insert_image.*unsaved/i)
 assert.equal((await skill.executeTool(call('replace_image',{page:1,image_number:1,url:input.url}))).mutated,true);assert.equal(saved.length,1)
 fail=true;const failed=await skill.executeTool(call('insert_image',input));assert.equal(failed.isError,true);assert.equal(failed.mutated,false)
 controller.abort();await assert.rejects(skill.executeTool(call('insert_image',input),controller.signal),{name:'AbortError'})
 const draftOnly=createPdfPreviewSkill(()=>pages,()=>true,...Array(15).fill(undefined),{...images,content:undefined})
 assert.ok(draftOnly.tools.some(tool=>tool.name==='insert_image'));assert.equal(draftOnly.tools.some(tool=>tool.name==='replace_image'),false)
})

test('existing image draft tools describe pending changes and user Save without claiming a revision',async()=>{
 const images={editsAreDrafts:true,read:async()=>[],edit:async()=>true,content:async()=>true}
 const skill=createPdfPreviewSkill(()=>pages,()=>true,...Array(15).fill(undefined),images)
 for(const [name,input]of [['transform_image',{x:20}],['rotate_image',{}],['delete_image',{}],['flip_image',{axis:'horizontal'}],['set_image_opacity',{opacity:.5}],['crop_image',{left:.2}],['remove_image_background',{}],['replace_image',{url:'https://example.com/a.png'}]]){
  const result=await skill.executeTool(call(name,{page:1,image_number:1,...input}))
  assert.equal(result.mutated,true,name);assert.match(result.output,/unsaved/i,name);assert.match(result.output,/user.*Save/i,name);assert.doesNotMatch(result.output,/new revision saved/i,name)
  assert.match(skill.tools.find(tool=>tool.name===name).description,/unsaved/i,name)
 }
 assert.match(skill.systemPrompt,/one.*edit.*image/i)
})
