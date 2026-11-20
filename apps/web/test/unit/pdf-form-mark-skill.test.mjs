import test from 'node:test'
import assert from 'node:assert/strict'
import {createPdfPreviewSkill} from '../../src/shell/pdf-preview-skill.ts'
const call=input=>({id:'mark',name:'add_form_mark',input})
function skill(callback){return createPdfPreviewSkill(()=>[{page:1,text:'Consent'}],()=>true,...Array(20).fill(undefined),callback)}
test('PDF form marks describe both the image and the checkbox change as pending',async()=>{
 assert.ok(!skill().tools.some(t=>t.name==='add_form_mark'))
 const received=[],abort=new AbortController(),input={page:1,kind:'check',anchor_text:'Consent',placement:'left'}
 let outcome={draft:{id:'I1',page:1,x:10,y:20,width:12,height:12}}
 const s=skill(async(...args)=>{received.push(args);return outcome})
 assert.match(s.tools.find(t=>t.name==='add_form_mark').description,/Only user Save.*(?:edits|changes)/i)
 const draft=await s.executeTool(call(input),abort.signal);assert.equal(draft.mutated,true);assert.match(draft.output,/unsaved.*I1|I1.*unsaved/i);assert.match(draft.output,/Save/);assert.deepEqual(received[0],[input,abort.signal])
 outcome={fieldName:'Approved'}
 const field=await s.executeTool(call({page:1,kind:'cross',x:12,y:15}));assert.equal(field.mutated,true);assert.match(field.output,/Approved/);assert.match(field.output,/unsaved/i);assert.doesNotMatch(field.output,/saved in a new revision/i)
})
test('PDF form marks reject invalid parameters or unavailable page without writing and preserve failed host result',async()=>{
 let writes=0
 const s=skill(async()=>{writes++;return null})
 for(const input of [{page:1,kind:'tick',x:0,y:0},{page:1,kind:'check'},{page:1,kind:'check',x:NaN},{page:1,kind:'check',x:0,size:0},{page:1,kind:'check',x:0,size:1001},{page:2,kind:'check',x:0},{page:1,kind:'check',x:0,placement:'diagonal'},{page:1,kind:'check',x:0,extra:true}]){
  const result=await s.executeTool(call(input));assert.equal(result.isError,true,JSON.stringify(input));assert.equal(result.mutated,false)
 }
 assert.equal(writes,0)
 const result=await s.executeTool(call({page:1,kind:'check',x:0,y:0}));assert.equal(result.isError,true);assert.equal(result.mutated,false);assert.equal(writes,1)
})
