import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {validateDocumentExecutionRequest} from '../../worker/src/sandbox/document-contract.ts'
test('Rust broker golden envelope uses the exact TS immutable native request fields',async()=>{
 const frame=JSON.parse(await readFile(new URL('../../../../services/document-broker/tests/fixtures/control-frame.json',import.meta.url),'utf8'))
 assert.deepEqual(validateDocumentExecutionRequest(frame.request,new Date('2030-01-01T00:00:00.000Z')),frame.request)
 assert.equal(frame.request.generation,0)
 assert.equal(frame.request.profileId,'pptx-edit-v1')
 assert.deepEqual(Object.keys(frame).sort(),['brokerBootId','context','operation','protocolVersion','request','requestId'])
})
