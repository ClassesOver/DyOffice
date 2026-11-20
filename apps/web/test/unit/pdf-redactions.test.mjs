import test from 'node:test'
import assert from 'node:assert/strict'
import {createPdfPreviewSkill} from '../../src/shell/pdf-preview-skill.ts'
import {createPdfExtraction} from '../../src/editors/pdf-extraction.ts'
const skill=marker=>createPdfPreviewSkill(()=>[{page:1,text:'Email alice@example.com'}],()=>true,...Array(18).fill(undefined),marker)
test('sensitive marking queues user review without an AI apply or document mutation',async()=>{
 const calls=[],s=skill(async(...args)=>{calls.push(args);return {count:2,truncated:false}}),signal=new AbortController().signal
 const result=await s.executeTool({id:'mark',name:'find_sensitive_info',input:{patterns:['email'],mark:true}},signal)
 assert.equal(result.mutated,false);assert.match(result.output,/Queued 2/);assert.match(result.output,/original PDF is unchanged/)
 assert.deepEqual(calls,[[['email'],signal]])
 assert.ok(!s.tools.some(tool=>/apply.*redact|redact.*apply/.test(tool.name)))
 const failed=await skill(async()=>({count:0,truncated:false,error:'Version changed'})).executeTool({id:'mark',name:'find_sensitive_info',input:{mark:true}});assert.equal(failed.isError,true);assert.equal(failed.mutated,false)
})
test('redaction copy publishes a new file and recovers the same upload after an unknown finish response',async()=>{
 const prepared={uploadId:'u',fileId:'copy',sha256:'a'.repeat(64),size:20},receipt={fileId:'copy',revision:'new',sha256:prepared.sha256,size:20},calls=[],opened=[];let finishes=0
 const client=createPdfExtraction({fileId:'original',name:'Original.pdf',getRevision:()=> 'revision',onCreated:async r=>opened.push(r),request:async(path,method,body)=>{
  calls.push({path,method,body})
  if(path.endsWith('/lease')&&method==='POST')return {leaseEpoch:3}
  if(path.endsWith('/redacted-copy/uploads'))return prepared
  if(path.endsWith('/finish')){if(++finishes===1)throw Error('lost response');return {format:'pdf',file:receipt}}
  if(path.includes('/revisions/'))return receipt
 }})
 const selection={patterns:['email'],ids:['candidate']}
 await assert.rejects(client.redact(selection),/lost response/);assert.equal(client.hasPending(),true)
 assert.equal(await client.confirm(),true);assert.deepEqual(opened,[receipt])
 assert.equal(calls.filter(c=>c.path.endsWith('/redacted-copy/uploads')).length,1)
 assert.deepEqual(calls.find(c=>c.path.endsWith('/redacted-copy/uploads')).body,{baseRevision:'revision',editorId:calls.find(c=>c.path.endsWith('/lease')).body.editorId,leaseEpoch:3,...selection,name:'Original-涂黑副本.pdf'})
 assert.equal(calls.some(c=>c.path.endsWith('/commits')),false)
})
