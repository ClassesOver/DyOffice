import { test } from 'node:test'
import assert from 'node:assert/strict'
import { revisionEvidence } from './revision-evidence.mjs'
test('QA receipt observer queries owner/file scope and emits only approved projections',async()=>{
 const queries=[],scope=['deployment','owner','file'],results=[{rows:[{source:'import',count:1},{source:'save',count:1}]},{rows:[{revision_id:'r2',upload_id:'u',requested_source_command_id:'c',idempotency_key:'k',base_revision:'r1',lease_epoch:'1'}]},{rows:[{command_id:'c',file_id:'file',upload_id:'u',sha256:'hash',size:'7',idempotency_key:'k'}]},{rows:[{count:1}]}]
 const proof=await revisionEvidence({query:async(sql,args)=>{assert.equal(args,scope);assert.match(sql,/deployment_id=\$1 AND .*owner_id=\$2 AND .*file_id=\$3/);queries.push(sql);return results.shift()}},scope)
 assert.equal(proof.fileRevisionCount,2);assert.equal(proof.revisionCommitCount,1);assert.equal(proof.commandUploadBindingCount,1);assert.equal(proof.exactCommandReceiptJoinCount,1)
 assert.doesNotMatch(JSON.stringify(proof),/session_id|editor_id|token|password/)
 assert.match(queries[3],/u\.session_id=b\.session_id/);assert.match(queries[3],/u\.editor_id=b\.editor_id/);assert.match(queries[3],/r\.parent_revision=rc\.base_revision/)
 assert.equal(queries.every(sql=>!/^\s*(INSERT|UPDATE|DELETE)/i.test(sql)),true)
})
