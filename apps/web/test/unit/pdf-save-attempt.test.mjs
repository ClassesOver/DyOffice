import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createPdfSaveAttempt} from '../../server/src/pdf/save-attempt.mjs'
const fileId='00000000-0000-4000-8000-000000000001', revision='00000000-0000-4000-8000-000000000002'
const receipt={fileId,revision,sha256:'a'.repeat(64),size:20}
const prepared={commitInput:{fileId,uploadId:'upload',idempotencyKey:'stable-key'},sha256:receipt.sha256,size:20}
test('lost reply retries same commit with no second preparation and rechecks even known receipts',async()=>{
  let preparations=0,calls=0;const inputs=[]
  const attempt=createPdfSaveAttempt({preparation:{async prepare(){preparations++;return prepared}},revisions:{async commitRevision(token,input){assert.equal(token,'captured');inputs.push({...input});if(++calls===1)throw Error('response lost');return receipt}}},{token:'captured'})
  await attempt.prepare();assert.equal(attempt.status,'prepared')
  await assert.rejects(attempt.commit(),{code:'PDF_COMMIT_UNKNOWN'});assert.equal(attempt.status,'unknown')
  assert.deepEqual(await attempt.commit(),receipt);assert.equal(attempt.status,'saved')
  await attempt.commit();assert.equal(calls,3);assert.equal(preparations,1)
  assert.deepEqual(inputs,[prepared.commitInput,prepared.commitInput,prepared.commitInput])
  await assert.rejects(attempt.prepare(),{code:'PDF_SAVE_STATE'})
})
test('overlap cannot queue duplicate preparation or commit',async()=>{
  let release;const gate=new Promise(resolve=>release=resolve)
  const attempt=createPdfSaveAttempt({preparation:{async prepare(){await gate;return prepared}},revisions:{async commitRevision(){await gate;return receipt}}},{token:'x'})
  const running=attempt.prepare()
  await assert.rejects(attempt.prepare(),{code:'PDF_SAVE_STATE'})
  await assert.rejects(attempt.commit(),{code:'PDF_SAVE_STATE'})
  release();await running
  const saving=attempt.commit();await assert.rejects(attempt.commit(),{code:'PDF_SAVE_STATE'});await saving
})
test('wrong receipt cannot report saved; unknown preserves same attempt',async()=>{
  const attempt=createPdfSaveAttempt({preparation:{async prepare(){return prepared}},revisions:{async commitRevision(){return {...receipt,sha256:'b'.repeat(64)}}}},{token:'x'})
  await attempt.prepare();await assert.rejects(attempt.commit(),{code:'PDF_COMMIT_UNKNOWN'});assert.equal(attempt.status,'unknown')
})
test('captures credentials and preparation input before caller mutation',async()=>{
  const input={token:'original',request:'original'}
  const attempt=createPdfSaveAttempt({preparation:{async prepare(i){assert.equal(i.token,'original');assert.equal(i.request,'original');return prepared}},revisions:{async commitRevision(token){assert.equal(token,'original');return receipt}}},input)
  input.token='changed';input.request='changed'
  await attempt.prepare();await attempt.commit()
})
test('failed preparation cannot be replayed and known save is not forgotten on recheck denial',async()=>{
  const broken=createPdfSaveAttempt({preparation:{async prepare(){throw Error('no')}},revisions:{}},{token:'x'})
  await assert.rejects(broken.prepare());assert.equal(broken.status,'failed')
  await assert.rejects(broken.prepare(),{code:'PDF_SAVE_STATE'})
  let n=0;const attempt=createPdfSaveAttempt({preparation:{async prepare(){return prepared}},revisions:{async commitRevision(){if(n++)throw Error('revoked');return receipt}}},{token:'x'})
  await attempt.prepare();await attempt.commit()
  await assert.rejects(attempt.commit(),{code:'PDF_COMMIT_RECHECK_FAILED'});assert.equal(attempt.status,'saved')
})

test('a receipt recheck cannot silently replace an already known revision',async()=>{
  let n=0
  const attempt=createPdfSaveAttempt({preparation:{async prepare(){return prepared}},revisions:{async commitRevision(){return n++?{...receipt,revision:'00000000-0000-4000-8000-000000000003'}:receipt}}},{token:'x'})
  await attempt.prepare();await attempt.commit()
  await assert.rejects(attempt.commit(),{code:'PDF_COMMIT_RECHECK_FAILED'})
  assert.equal(attempt.status,'saved')
})
