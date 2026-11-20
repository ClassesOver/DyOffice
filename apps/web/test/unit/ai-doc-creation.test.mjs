import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createAiDocCreationQueue} from '../../src/shell/ai-doc-creation.ts'

const content={title:'Report',html:'<p>Written body</p>'}
const revision={fileId:'file',revision:'saved',sha256:'a'.repeat(64),size:100}
test('DOCX creation waits for consumption and a persisted revision, not merely opening a tab',async()=>{
 const queue=createAiDocCreationQueue(),pending=queue.begin('file',content)
 let settled=false;void pending.then(()=>{settled=true})
 await Promise.resolve();assert.equal(settled,false)
 assert.deepEqual(queue.consume('file'),content);assert.equal(queue.consume('file'),null)
 await Promise.resolve();assert.equal(settled,false)
 queue.complete('file',{ok:true,revision})
 assert.deepEqual(await pending,revision)
})
test('unconsumed or mismatched creation receipt cannot acknowledge a blank file',async()=>{
 for(const consumed of [false,true]){
  const queue=createAiDocCreationQueue(),pending=queue.begin('file',content)
  if(consumed)queue.consume('file')
  queue.complete('file',{ok:true,revision:{...revision,fileId:consumed?'other':'file'}})
  await assert.rejects(pending,/确认/)
 }
})
test('save failure and editor closure reject creation and release queued content',async()=>{
 const queue=createAiDocCreationQueue(),pending=queue.begin('file',content)
 queue.complete('file',{ok:false,error:'正文未保存'})
 await assert.rejects(pending,/正文未保存/)
 assert.equal(queue.consume('file'),null)
})
test('unacknowledged DOCX times out without claiming success or recreating the file',async()=>{
 const queue=createAiDocCreationQueue(5),pending=queue.begin('file',content)
 await assert.rejects(pending,/不要重复创建/)
 assert.equal(queue.consume('file'),null)
})
