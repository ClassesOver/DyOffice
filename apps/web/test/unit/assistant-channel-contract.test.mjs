import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {decodeAgentAction,canTransition} from '../../../../packages/web-contracts/src/assistant-channel.ts'
test('channel actions reject impersonation, unknown fields and oversized UTF-8 input',()=>{
 const input={requestId:randomUUID(),conversationId:randomUUID(),to:'office',action:{kind:'delegate',instruction:'Read the document'}}
 assert.deepEqual(decodeAgentAction(input),input)
 for(const value of [{...input,from:'owner'},{...input,action:{...input.action,owner:'owner'}},{...input,action:{kind:'message',content:'中'.repeat(11000)}},{...input,action:{kind:'result',taskId:randomUUID(),claimId:randomUUID(),connectionEpoch:0,summary:'done',outcome:'succeeded'}}])assert.throws(()=>decodeAgentAction(value))
})
test('terminal channel tasks never automatically execute again',()=>{
 for(const state of ['succeeded','failed','cancelled'])assert.equal(canTransition(state,'running'),false)
 assert.equal(canTransition('running','waiting_peer'),true)
 assert.equal(canTransition('unknown_outcome','running'),false)
})
test('saved-revision execution is explicit and limited to delegations to Office',()=>{
 const input={requestId:randomUUID(),conversationId:randomUUID(),to:'office',action:{kind:'delegate',instruction:'Read the saved document',execution:'saved-revision'}}
 assert.deepEqual(decodeAgentAction(input),input)
 assert.throws(()=>decodeAgentAction({...input,to:randomUUID()}))
 assert.throws(()=>decodeAgentAction({...input,action:{kind:'message',content:'Read',execution:'saved-revision'}}))
 assert.throws(()=>decodeAgentAction({...input,action:{...input.action,execution:'arbitrary'}}))
 assert.throws(()=>decodeAgentAction({...input,action:{kind:'result',taskId:randomUUID(),claimId:randomUUID(),connectionEpoch:1,summary:'done',outcome:'succeeded',execution:'saved-revision'}}))
})
