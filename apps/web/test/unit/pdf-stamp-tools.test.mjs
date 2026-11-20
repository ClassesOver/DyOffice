import test from 'node:test'
import assert from 'node:assert/strict'
import {createPdfPreviewSkill} from '../../src/shell/pdf-preview-skill.ts'
import {createPdfMutations} from '../../src/editors/pdf-mutations.ts'
const call=(name,input)=>({id:'stamp',name,input})
function skill(write){return createPdfPreviewSkill(()=>[{page:1,text:'Original',width:600,height:800}],()=>true,...Array(16).fill(undefined),write)}

test('stamp tools keep PC parameters and only report a confirmed saved revision',async()=>{
 const writes=[],controller=new AbortController();let saved=true
 const s=skill(async(...args)=>{writes.push(args);return saved})
 for(const name of ['set_watermark','set_header_footer'])assert.ok(s.tools.some(tool=>tool.name===name))
 const wm={text:'  内部资料  ',angle:35,opacity:.2,color:'#123456',size:.1}
 const hf={header_left:'Project',header_center:'{page} of {total}',footer_right:'Confidential',page_number:true,start_at:3,font_size:10,color:'445566'}
 assert.equal((await s.executeTool(call('set_watermark',wm),controller.signal)).mutated,true)
 assert.equal((await s.executeTool(call('set_header_footer',hf),controller.signal)).mutated,true)
 assert.deepEqual(writes,[[{op:'set_watermark',...wm,text:'内部资料'},controller.signal],[{op:'set_header_footer',...hf},controller.signal]])
 assert.equal((await s.executeTool(call('set_watermark',{text:''}))).mutated,true)
 assert.equal((await s.executeTool(call('set_header_footer',{}))).mutated,true)
 saved=false;const failure=await s.executeTool(call('set_watermark',{text:'draft'}));assert.equal(failure.isError,true);assert.equal(failure.mutated,false)
 assert.equal(skill().tools.some(tool=>tool.name==='set_watermark'),false)
 assert.equal((await skill().executeTool(call('set_watermark',{text:'draft'}))).isError,true)
 controller.abort();await assert.rejects(s.executeTool(call('set_watermark',wm),controller.signal),{name:'AbortError'})
})

test('invalid stamp configurations never reach the PDF writer',async()=>{
 let writes=0;const s=skill(async()=>{writes++;return true})
 const invalid=[['set_watermark',{}],['set_watermark',{text:null}],['set_watermark',{text:'x',angle:181}],['set_watermark',{text:'x',opacity:-.1}],['set_watermark',{text:'x',size:.01}],['set_watermark',{text:'x',color:'red'}],['set_watermark',{text:'x',angle:NaN}],['set_watermark',{text:'x',unexpected:true}],['set_watermark',{text:'x',op:'set_header_footer'}],['set_watermark',{text:'a\nb'}],['set_watermark',{text:'x'.repeat(2001)}],['set_header_footer',{page_number:'true'}],['set_header_footer',{start_at:1.5}],['set_header_footer',{font_size:3}],['set_header_footer',{header_left:null}],['set_header_footer',{footer_right:'a\u0000b'}],['set_header_footer',{text:'x'}]]
 for(const [name,input] of invalid){const result=await s.executeTool(call(name,input));assert.equal(result.isError,true,name);assert.equal(result.mutated,false)}
 assert.equal(writes,0)
})

test('stamp saves stage exactly one configuration and recover the same commit after response loss',async()=>{
 const requests=[],saved=[],controller=new AbortController();let commits=0
 const input={fileId:'file',uploadId:'upload',baseRevision:'old',leaseEpoch:3,idempotencyKey:'same-key'}
 const client=createPdfMutations({fileId:'file',getRevision:()=> 'old',onSaved:async receipt=>saved.push(receipt),request:async(path,method,body)=>{
  requests.push({path,method,body})
  if(path.endsWith('/lease')&&method==='POST')return {leaseEpoch:3}
  if(path.endsWith('/pdf/stamps/uploads'))return {commitInput:input}
  if(path.endsWith('/commits')){if(++commits===1)throw new TypeError('lost response');return {fileId:'file',revision:'new'}}
 }})
 const operation={op:'set_watermark',text:'CONFIDENTIAL'}
 await assert.rejects(client.mutate('stamps',[operation],controller.signal),/lost response/)
 assert.equal(client.hasPending(),true);assert.equal(await client.mutate('stamps',[operation]),false)
 const staged=requests.find(r=>r.path.endsWith('/pdf/stamps/uploads'))
 assert.deepEqual(staged.body.operation,operation);assert.equal('operations' in staged.body,false)
 assert.equal(await client.confirm(),true);assert.deepEqual(saved,[{fileId:'file',revision:'new'}])
 assert.equal(requests.filter(r=>r.path.endsWith('/pdf/stamps/uploads')).length,1)
 assert.deepEqual(requests.filter(r=>r.path.endsWith('/commits')).map(r=>r.body),[input,input])
 assert.equal(await client.mutate('stamps',[]),false)
 assert.equal(await client.mutate('stamps',[operation,operation]),false)
})
