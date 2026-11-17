import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID,randomBytes} from 'node:crypto'
import * as impl from '../../worker/src/sandbox/document-native-authority-pg.ts'
import * as unified from '../../worker/src/sandbox/document-unified-authority-pg.ts'
import {pool,schema,owner,worker,outsider,issuer,as,rolePool,fixture,registered,issued} from '../helpers/document-authority-pg.mjs'
// Real Rust process and real PG composition. The 3 input bytes are trusted metadata
// fixtures and never reach an engine; no output artifact or T06 writer is invoked.
for(const binary of ['socketpair-denial','default-disabled','stall','stdout-flood','stderr-flood','partial','early-close'])test(`actual Rust ${binary} leaves native attempt quarantined and T06 unchanged`,async()=>{
 const {createTestDocumentExecutionBoundary}=await import('../../worker/src/sandbox/document-execution-boundary.ts')
 const {createTestBrokerAdmissionBackend}=await import('../../worker/src/sandbox/document-broker-admission.ts')
 const {createTestPostgresDocumentReservations}=await import('../../worker/src/sandbox/document-reservations-pg.ts')
 const {createTestDocumentReconciler}=await import('../../worker/src/sandbox/document-reconcile.ts')
 const input=new Uint8Array([1,2,3]),f=await fixture({sha:createHash('sha256').update(input).digest('hex')}),i=await issued(f)
 await as(owner,c=>c.query('INSERT INTO document_capacity VALUES($1,1)',[f.expected.deploymentId]))
 const ledger=()=>createTestPostgresDocumentReservations(rolePool(owner),{schema,deploymentId:f.expected.deploymentId,unsafeTestOnly:true})
 const reservations=ledger(),authority=unified.createTestUnifiedAuthority(rolePool(worker),{schema,unsafeTestOnly:true,context:i.context,jobToken:f.token})
 const snapshot=()=>as(owner,async c=>{await c.query('BEGIN');try{
  // Establish actual authenticated job scope, not a blind owner/RLS-empty query.
  await c.query('SELECT document_native_authority($1,$2)',[f.expected,createHash('sha256').update(f.token).digest('hex')])
  const r=(await c.query('SELECT (SELECT count(*)::int FROM file_revisions) revisions,(SELECT count(*)::int FROM uploads) uploads,(SELECT count(*)::int FROM revision_commits) receipts,(SELECT count(*)::int FROM revision_outbox) events,(SELECT current_revision FROM files WHERE id=$1) head',[f.expected.fileId])).rows[0]
  await c.query('COMMIT');return r
 }catch(e){await c.query('ROLLBACK');throw e}})
 const before=await snapshot();assert.equal(before.revisions,1);assert.equal(before.uploads,0);assert.equal(before.receipts,0);assert.equal(before.head,f.expected.baseRevision)
 const runtime=createTestDocumentExecutionBoundary({authority,reservations,backend:createTestBrokerAdmissionBackend({unsafeTestOnly:true,context:i.context,brokerBootId:randomUUID(),fixture:binary})},{unsafeTestOnly:true,operationTimeoutMs:3000,cleanupTimeoutMs:1000})
 const reservation={reservationId:`${f.expected.deploymentId}/${f.expected.jobId}/1/1`,jobId:f.expected.jobId,attempt:1,jobEpoch:1}
 await assert.rejects(()=>runtime.run(i.request,input),{code:'DOCUMENT_INSTANCE_UNKNOWN',reservationKey:reservation.reservationId})
 assert.deepEqual(await snapshot(),before)
 const held=await reservations.inspect(reservation);assert.equal(held.state,'quarantined');assert.equal(held.launchEvidence,'may_started');assert.equal(held.handle,null)
 const restarted=ledger(),result=await createTestDocumentReconciler(restarted,{unsafeTestOnly:true}).reconcile(reservation)
 assert.equal(result.outcome,'blocked_uncertified');assert.equal((await restarted.recoverable()).length,1)
 assert.equal((await restarted.inspect(reservation)).state,'quarantined');assert.deepEqual(await snapshot(),before)
})
