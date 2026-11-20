import test from 'node:test'
import assert from 'node:assert/strict'
import {createPdfPreviewSkill} from '../../src/shell/pdf-preview-skill.ts'
import {createPdfMutations} from '../../src/editors/pdf-mutations.ts'
const create=write=>createPdfPreviewSkill(()=>[{page:1,text:'One'},{page:2,text:'Two'},{page:3,text:'Three'}],()=>true,...Array(17).fill(undefined),write)
test('replace_pages waits for the user selected source and only claims a confirmed revision',async()=>{
 let selected=false,calls=[];const abort=new AbortController(),skill=create(async(...args)=>{calls.push(args);return selected})
 assert.ok(skill.tools.some(t=>t.name==='replace_pages'));assert.equal(create().tools.some(t=>t.name==='replace_pages'),false)
 const run=input=>skill.executeTool({id:'replace',name:'replace_pages',input},abort.signal)
 for(const input of [{pages:[]},{pages:[0]},{pages:[4]},{pages:[1,1]},{pages:[1.5]},{pages:[1],path:'/tmp/remote.pdf'}])assert.equal((await run(input)).isError,true)
 assert.equal(calls.length,0)
 assert.equal((await run({pages:[3,1]})).mutated,false);assert.deepEqual(calls[0],[[1,3],abort.signal])
 selected=true;assert.equal((await run({pages:[1]})).mutated,true)
 abort.abort();await assert.rejects(run({pages:[1]}),{name:'AbortError'})
})
test('replacement uploads the exact selected Blob with revision metadata and recovers only the original commit',async()=>{
 const calls=[],source=new Blob(['%PDF-source']),input={fileId:'f',uploadId:'u',baseRevision:'r',leaseEpoch:2,idempotencyKey:'key'};let commits=0,saved=0
 const client=createPdfMutations({fileId:'f',getRevision:()=> 'r',onSaved:async()=>{saved++},request:async(path,method,body)=>{
  calls.push({path,method,body})
  if(path.endsWith('/lease')&&method==='POST')return {leaseEpoch:2}
  if(path.includes('/replace-pages/uploads?'))return {commitInput:input}
  if(path.endsWith('/commits')){if(++commits===1)throw Error('lost');return {fileId:'f',revision:'new'}}
 }})
 await assert.rejects(client.mutate('replace-pages',[{pages:[1,3],source}]),/lost/)
 assert.ok(client.hasPending());assert.equal(await client.mutate('replace-pages',[{pages:[1],source}]),false)
 assert.equal(await client.confirm(),true);assert.equal(saved,1)
 const stages=calls.filter(c=>c.path.includes('/replace-pages/uploads?'));assert.equal(stages.length,1);assert.equal(stages[0].body,source)
 const query=new URL(stages[0].path,'http://test').searchParams;assert.equal(query.get('baseRevision'),'r');assert.equal(query.get('leaseEpoch'),'2');assert.deepEqual(JSON.parse(query.get('pages')),[1,3]);assert.ok(query.get('idempotencyKey'))
 const receipts=calls.filter(c=>c.path.endsWith('/commits'));assert.deepEqual(receipts.map(c=>c.body),[input,input])
})
test('page insertion uploads the selected PDF with its after-page index and revision metadata',async()=>{
 const calls=[],source=new Blob(['%PDF-source']),input={fileId:'f',uploadId:'u',baseRevision:'r',leaseEpoch:2,idempotencyKey:'key'}
 const client=createPdfMutations({fileId:'f',getRevision:()=> 'r',onSaved:async()=>{},request:async(path,method,body)=>{
  calls.push({path,method,body})
  if(path.endsWith('/lease')&&method==='POST')return {leaseEpoch:2}
  if(path.includes('/insert-pages/uploads?'))return {commitInput:input}
  if(path.endsWith('/commits'))return {fileId:'f',revision:'new'}
 }})
 assert.equal(await client.mutate('insert-pages',[{afterPageIndex:-1,source}]),true)
 const stage=calls.find(call=>call.path.includes('/insert-pages/uploads?'))
 assert.equal(stage.body,source)
 const query=new URL(stage.path,'http://test').searchParams
 assert.equal(query.get('baseRevision'),'r');assert.equal(query.get('leaseEpoch'),'2');assert.equal(query.get('afterPageIndex'),'-1');assert.ok(query.get('idempotencyKey'))
 const commit=calls.findLast(call=>call.path.endsWith('/commits'));assert.equal(commit.method,'POST')
 for(const invalid of [{afterPageIndex:-2,source},{afterPageIndex:100,source},{afterPageIndex:0,source:new Blob()}])assert.equal(await client.mutate('insert-pages',[invalid]),false)
})
