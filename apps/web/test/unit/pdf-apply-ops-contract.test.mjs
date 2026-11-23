import test from 'node:test'
import assert from 'node:assert/strict'
import {validatePdfApplyOperations} from '../../../../packages/web-contracts/src/pdf-apply-ops.ts'
import {callableOpNames} from '../../../pdf/src/shared/op-docs.ts'
const field={op:'addFormField',field:{name:'new',kind:'text',page:1,x:10,y:20,width:100,height:20,value:'hello'}}
const samples=[{op:'removeMarkup',id:'P1'},{op:'setNoteContents',id:'Pnote-1',contents:' updated '},{op:'removeTextInsert',id:'T1'},{op:'setFormValue',value:{name:'existing',value:'filled'}},field,{op:'rotatePages',pages:[1,2],dir:90},{op:'deletePage',page:3},{op:'setPageOrder',order:[2,1]},{op:'setMetadata',metadata:{title:' Title ',keywords:''}}]
const rejects=input=>assert.throws(()=>validatePdfApplyOperations(input,3),{code:'INVALID_PDF_APPLY_OPS'})
test('accepts exactly the nine PC callable model-facing operations in one snapshot',()=>{
 assert.deepEqual(samples.map(o=>o.op).sort(),callableOpNames().sort())
 const result=validatePdfApplyOperations(samples,3)
 assert.equal(result.length,9);assert.equal(result[1].contents,'updated');assert.equal(result[8].metadata.title,'Title')
 assert.equal(result[0].id,'P1');assert.equal(result[2].id,'T1');assert.deepEqual(result[5].pages,[1,2]);assert.equal(result[6].page,3)
 for(const input of [[{op:'setMetadata',metadata:null}],[{op:'setPageOrder',order:null}],[{op:'setFormValue',value:{name:'check',checked:false}}]])assert.equal(validatePdfApplyOperations(input,3).length,1)
})
test('rejects unknown vocabulary, keys, legacy saved references and wrong pending ID types',()=>{
 for(const op of [{op:'deleteSavedAnnot',id:'P1'},{op:'removeDrawing',id:'P1'},{op:'insertBlankPage',afterPage:0},{op:'removeMarkup',id:'P1',page:1},{op:'removeMarkup',id:'S12'},{op:'removeMarkup',id:'12R'},{op:'removeMarkup',id:'T1'},{op:'removeMarkup',id:'P'},{op:'removeTextInsert',id:'P1'},{op:'removeTextInsert',id:'1'},{op:'removeTextInsert',id:'T1',unknown:1},{op:'setNoteContents',id:'P1',contents:' '},{op:'setFormValue',value:{name:'f',value:'v',checked:true}},{op:'setFormValue',value:{name:'f',kind:'text',value:'v'}},{op:'setFormValue',value:{name:'f'}},{op:'deletePage',pageIndex:0},{op:'rotatePages',pages:['1'],dir:90},{op:'rotatePages',pages:[1,1],dir:90},{op:'setMetadata',metadata:{path:'/tmp/a'}}])rejects([op])
})
test('enforces 1..50 operations and valid pageCount even for nonpage operations',()=>{
 rejects([]);rejects(Array.from({length:51},()=>samples[0]));assert.equal(validatePdfApplyOperations(Array.from({length:50},()=>samples[0]),3).length,50)
 for(const count of [0,101,1.5,NaN])assert.throws(()=>validatePdfApplyOperations([samples[0]],count),{code:'INVALID_PDF_APPLY_OPS'})
})
test('reuses field and page validation including cumulative page semantics',()=>{
 for(const ops of [[{...field,field:{...field.field,page:4}}],[{op:'rotatePages',pages:[4],dir:90}],[{op:'deletePage',page:1},{op:'rotatePages',pages:[1],dir:90}],[{op:'deletePage',page:1},{op:'setPageOrder',order:[3,2,1]}],[{op:'deletePage',page:1},{op:'deletePage',page:2},{op:'deletePage',page:3}],[field,field],[{...field,field:{...field.field,options:['bad']}}]])rejects(ops)
 const radio=value=>({op:'addFormField',field:{...field.field,name:'r',kind:'radio',value:undefined,exportValue:value}})
 const a=radio('a'),b=radio('b');delete a.field.value;delete b.field.value
 assert.equal(validatePdfApplyOperations([a,b],3).length,2);rejects([a,a])
})
test('rejects accessors at every input level without invoking them',()=>{
 let called=0;const getter=()=>{called++;return 'bad'}
 const cases=[]
 const op={op:'removeMarkup'};Object.defineProperty(op,'id',{enumerable:true,get:getter});cases.push([op])
 const nested={name:'f'};Object.defineProperty(nested,'value',{enumerable:true,get:getter});cases.push([{op:'setFormValue',value:nested}])
 const pages=[1];Object.defineProperty(pages,'0',{enumerable:true,get:getter});cases.push([{op:'rotatePages',pages,dir:90}])
 const options=['a'];Object.defineProperty(options,'0',{enumerable:true,get:getter});cases.push([{...field,field:{...field.field,kind:'choice',value:'a',options}}])
 const batch=[samples[0]];Object.defineProperty(batch,'0',{enumerable:true,get:getter});cases.push(batch)
 for(const input of cases)rejects(input);assert.equal(called,0)
})
test('rejects symbols, nonplain objects, hidden properties, sparse and extended arrays',()=>{
 const symbol={...samples[0],[Symbol('extra')]:1},hidden={...samples[0]};Object.defineProperty(hidden,'hidden',{value:1})
 const extra=[samples[0]];extra.extra=1
 for(const input of [[symbol],[hidden],[Object.create(samples[0])],new Array(1),extra])rejects(input)
})
test('returns deeply frozen detached snapshots without freezing or mutating caller data',()=>{
 const input=[{op:'rotatePages',pages:[1],dir:90},{op:'setMetadata',metadata:{title:'title'}},{...field,field:{...field.field}},{op:'setFormValue',value:{name:'f',value:'v'}}]
 const output=validatePdfApplyOperations(input,3)
 const walk=value=>{if(value&&typeof value==='object'){assert.equal(Object.isFrozen(value),true);for(const child of Object.values(value))walk(child)}};walk(output)
 input[0].pages.push(2);input[1].metadata.title='changed';input[2].field.value='changed';input[3].value.value='changed'
 assert.deepEqual(output[0].pages,[1]);assert.equal(output[1].metadata.title,'title');assert.equal(output[2].field.value,'hello');assert.equal(output[3].value.value,'v');assert.equal(Object.isFrozen(input),false)
})

test('rejects creating a field on a page deleted earlier in the same batch',()=>{
 rejects([{op:'deletePage',page:1},field])
 assert.equal(validatePdfApplyOperations([field,{op:'deletePage',page:1}],3).length,2)
})
test('keeps repeated pending deletes as idempotent shapes like PC and requires explicit pending prefixes',()=>{
 assert.equal(validatePdfApplyOperations([{op:'removeTextInsert',id:'T1'},{op:'removeTextInsert',id:'T1'}],3).length,2)
 for(const id of ['S1','12R',' P1','P1 ','P\n1','P\u00001'])rejects([{op:'removeMarkup',id}])
})
