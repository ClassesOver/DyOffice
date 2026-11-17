import {test} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {PDFDocument} from 'pdf-lib'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {createLeaseService} from '../../server/src/modules/leases/service.ts'
import {createRevisionService} from '../../server/src/modules/revisions/service.ts'
import {createPdfRotationJob} from '../../server/src/pdf/rotation-job.mjs'
import {createPdfSavePreparation} from '../../server/src/pdf/save-preparation.mjs'
const request=JSON.stringify({version:1,action:'rotatePages',operations:[{page:1,degrees:90}]})
async function fixture(t){
  const f=await fileFixture(t,{buildApp:false}),doc=await PDFDocument.create();doc.addPage([200,100])
  const initial=(await importFile(f,f.alice.token,Buffer.from(await doc.save()),'sample.pdf')).file
  const leases=createLeaseService({transactions:f.transactions}),revisions=createRevisionService({transactions:f.transactions,objects:f.objects,files:f.files})
  const editorId=randomUUID(),lease=await leases.acquireLease(f.alice.token,initial.fileId,{editorId})
  const input={token:f.alice.token,fileId:initial.fileId,baseRevision:initial.revision,editorId,leaseEpoch:lease.leaseEpoch,idempotencyKey:randomUUID(),request}
  const make=(processor=createPdfRotationJob())=>createPdfSavePreparation({files:f.files,leases,revisions,processor})
  return {...f,initial,leases,revisions,input,make}
}

for(const scenario of [
 {name:'session revocation',status:401,async invalidate(f){await f.sessions.logout(f.alice.token)}},
 {name:'lease takeover',status:409,async invalidate(f){await f.leases.takeoverLease(f.alice.token,f.initial.fileId,{editorId:randomUUID(),expectedEpoch:f.input.leaseEpoch})}},
 {name:'head revision advance',status:409,async invalidate(f){const other=await f.make().prepare({...f.input,idempotencyKey:randomUUID()});await f.revisions.commitRevision(f.alice.token,other.commitInput)}},
])test(`download-time ${scenario.name} rejects before handing bytes to PDF processor`,async t=>{
 const f=await fixture(t);let processed=0,staged=0
 const prep=createPdfSavePreparation({leases:f.leases,
  files:{...f.files,async download(...args){const source=await f.files.download(...args);await scenario.invalidate(f);return source}},
  revisions:{...f.revisions,async stageUpload(...args){staged++;return f.revisions.stageUpload(...args)}},
  processor:{execute(){processed++;throw Error('PROCESSOR_MUST_NOT_RECEIVE_BYTES')}}})
 await assert.rejects(prep.prepare(f.input),e=>e.statusCode===scenario.status)
 assert.equal(processed,0);assert.equal(staged,0)
})
