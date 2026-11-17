import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Pool } from 'pg'
import { randomUUID } from 'node:crypto'
import { fileFixture, docxBytes } from '../helpers/files.mjs'
import { createFileService } from '../../server/src/modules/files/service.ts'

async function inspect(f, sql, values) {
  const url=new URL(process.env.DYOFFICE_TEST_DATABASE_URL);url.pathname='/'+f.database
  const pool=new Pool({connectionString:url.href})
  try{return await pool.query(sql,values)}finally{await pool.end()}
}
async function expire(f, id) {
  await inspect(f,"UPDATE uploads SET created_at=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 hour' WHERE id=$1", [id])
}
async function state(f, id) {
  return (await inspect(f,'SELECT state,attempt_id,sha256 FROM uploads WHERE id=$1', [id])).rows[0]
}
// The wrapper runs only after the real receiving transaction has committed. It
// makes expiry deterministic without changing the validator or production clock.
function afterClaim(f, hook) {
  return createFileService({ objects:f.objects, transactions:{
    async withPrincipalTransaction(input, fn) {
      const result=await f.transactions.withPrincipalTransaction(input,fn)
      if(result?.row?.state==='staged' && result.key) await hook(result.row.id)
      return result
    },
  } })
}
for(const sweep of [false,true]) test(`failed pre-PUT validation releases expired accounting (prior sweep=${sweep})`,async t=>{
  let puts=0
  const f=await fileFixture(t,{wrapObjects:store=>({...store,async putImmutable(...args){puts++;return store.putImmutable(...args)}})})
  const draft=await f.files.stageUpload(f.alice.token,{name:'bad.docx',size:8})
  const files=afterClaim(f,async id=>{await expire(f,id);if(sweep)await f.files.usage(f.alice.token)})
  await assert.rejects(()=>files.receiveUpload(f.alice.token,draft.uploadId,Buffer.alloc(1)),{statusCode:400})
  assert.equal(puts,0)
  assert.deepEqual(await state(f,draft.uploadId),{state:'expired',attempt_id:null,sha256:null})
  assert.deepEqual(await f.files.usage(f.alice.token),{reservedBytes:0,storedBytes:0,quotaBytes:1024**3})
  await assert.rejects(()=>files.receiveUpload(f.alice.token,draft.uploadId,Buffer.alloc(1)),{statusCode:410})
  assert.equal((await f.files.usage(f.alice.token)).storedBytes,0)
})
test('expired cleanup does not clear a different attempt or credit uncertain bytes',async t=>{
  const f=await fileFixture(t),replacement=randomUUID()
  const draft=await f.files.stageUpload(f.alice.token,{name:'bad.docx',size:8})
  const files=afterClaim(f,async id=>{await expire(f,id);await inspect(f,'UPDATE uploads SET attempt_id=$2 WHERE id=$1',[id,replacement])})
  await assert.rejects(()=>files.receiveUpload(f.alice.token,draft.uploadId,Buffer.alloc(1)),{statusCode:400})
  assert.equal((await f.files.usage(f.alice.token)).storedBytes,8)
  assert.equal((await state(f,draft.uploadId)).attempt_id,replacement)
})
test('revoked session cannot mutate expired pre-PUT cleanup',async t=>{
  const f=await fileFixture(t),draft=await f.files.stageUpload(f.alice.token,{name:'bad.docx',size:8})
  const files=afterClaim(f,async id=>{await expire(f,id);await f.sessions.logout(f.alice.token)})
  await assert.rejects(()=>files.receiveUpload(f.alice.token,draft.uploadId,Buffer.alloc(1)),{statusCode:400})
  const row=await state(f,draft.uploadId)
  assert.equal(row.state,'receiving');assert.ok(row.attempt_id)
})
test('a failed PUT after expiry retains its uncertain object and charge',async t=>{
  let f,id,puts=0
  f=await fileFixture(t,{wrapObjects:store=>({...store,async putImmutable(...args){puts++;await store.putImmutable(...args);await expire(f,id);throw Error('lost PUT response')}})})
  const bytes=await docxBytes(),draft=await f.files.stageUpload(f.alice.token,{name:'report.docx',size:bytes.length});id=draft.uploadId
  await assert.rejects(()=>f.files.receiveUpload(f.alice.token,id,bytes),/lost PUT response/)
  assert.equal(puts,1)
  assert.equal((await f.files.usage(f.alice.token)).storedBytes,bytes.length)
  assert.ok((await state(f,id)).attempt_id)
  assert.deepEqual(await f.files.reclaimAbandonedUploads(f.alice.token),{reclaimedBytes:0,reclaimedUploads:0})
})

test('expired pre-PUT revision rejection no longer blocks permanent purge',async t=>{
  const { importFile }=await import('../helpers/files.mjs')
  const { createLeaseService }=await import('../../server/src/modules/leases/service.ts')
  const { createRevisionService }=await import('../../server/src/modules/revisions/service.ts')
  const f=await fileFixture(t),bytes=await docxBytes(),initial=(await importFile(f,f.alice.token,bytes)).file
  const editorId=randomUUID(),lease=await createLeaseService({transactions:f.transactions}).acquireLease(f.alice.token,initial.fileId,{editorId})
  const revisions=createRevisionService({transactions:f.transactions,objects:f.objects,files:f.files})
  const draft=await revisions.stageUpload(f.alice.token,initial.fileId,{size:bytes.length,baseRevision:initial.revision,leaseEpoch:lease.leaseEpoch,editorId})
  const files=afterClaim(f,id=>expire(f,id))
  await assert.rejects(()=>files.receiveUpload(f.alice.token,draft.uploadId,Buffer.alloc(1)),{statusCode:400})
  assert.equal((await f.files.usage(f.alice.token)).storedBytes,bytes.length)
  assert.deepEqual(await f.files.readFile(f.alice.token,initial.fileId,initial.revision),bytes)
  await f.files.trashFile(f.alice.token,initial.fileId)
  assert.deepEqual(await f.files.purgeFile(f.alice.token,initial.fileId),{state:'purged'})
  assert.equal((await f.files.usage(f.alice.token)).storedBytes,0)
})

test('cleanup transaction failure rolls back both terminal proof and quota credit',async t=>{
  const f=await fileFixture(t),draft=await f.files.stageUpload(f.alice.token,{name:'bad.docx',size:8})
  let injected=0
  const transactions={async withPrincipalTransaction(input,fn){
    const result=await f.transactions.withPrincipalTransaction(input,(c,p)=>fn(new Proxy(c,{
      get(target,key){
        if(key==='query')return async(...args)=>{
          const result=await target.query(...args)
          if(typeof args[0]==='string' && args[0].startsWith('UPDATE uploads SET attempt_id=NULL')){injected++;throw Error('rollback after proof update')}
          return result
        }
        const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value
      },
    }),p))
    if(result?.row?.state==='staged' && result.key){await expire(f,result.row.id);await f.files.usage(f.alice.token)}
    return result
  }}
  const files=createFileService({transactions,objects:f.objects})
  await assert.rejects(()=>files.receiveUpload(f.alice.token,draft.uploadId,Buffer.alloc(1)),{statusCode:400})
  assert.equal(injected,1)
  assert.ok((await state(f,draft.uploadId)).attempt_id)
  assert.equal((await f.files.usage(f.alice.token)).storedBytes,8)
})

test('a genuinely late PUT remains fenced after expiry sweep and attempted purge',async t=>{
  const { importFile }=await import('../helpers/files.mjs')
  const { createLeaseService }=await import('../../server/src/modules/leases/service.ts')
  const { createRevisionService }=await import('../../server/src/modules/revisions/service.ts')
  let enter,release,delay=false,published
  const entered=new Promise(resolve=>{enter=resolve}),hold=new Promise(resolve=>{release=resolve})
  const f=await fileFixture(t,{wrapObjects:store=>({...store,async putImmutable(...args){
    if(delay){enter();await hold}
    const ref=await store.putImmutable(...args);if(delay)published=ref;return ref
  }})})
  const bytes=await docxBytes(),initial=(await importFile(f,f.alice.token,bytes)).file
  const editorId=randomUUID(),lease=await createLeaseService({transactions:f.transactions}).acquireLease(f.alice.token,initial.fileId,{editorId})
  const revisions=createRevisionService({transactions:f.transactions,objects:f.objects,files:f.files})
  const draft=await revisions.stageUpload(f.alice.token,initial.fileId,{size:bytes.length,baseRevision:initial.revision,leaseEpoch:lease.leaseEpoch,editorId})
  delay=true
  const receiving=f.files.receiveUpload(f.alice.token,draft.uploadId,bytes).then(value=>({value}),error=>({error}))
  try{
    await Promise.race([entered,receiving.then(()=>{throw Error('Receive ended before PUT barrier')})])
    await expire(f,draft.uploadId)
    assert.equal((await f.files.usage(f.alice.token)).storedBytes,bytes.length*2)
    await f.files.trashFile(f.alice.token,initial.fileId)
    await assert.rejects(()=>f.files.purgeFile(f.alice.token,initial.fileId),{statusCode:409})
    release()
    assert.equal((await receiving).error?.statusCode,410)
    assert.ok(published,'the delayed PUT really reached the local object store')
    assert.deepEqual(await f.objects.readVerified(published),bytes)
    const row=await state(f,draft.uploadId)
    assert.equal(row.state,'expired');assert.ok(row.attempt_id);assert.equal(row.sha256,null)
    assert.deepEqual(await f.files.reclaimAbandonedUploads(f.alice.token),{reclaimedBytes:0,reclaimedUploads:0})
    await assert.rejects(()=>f.files.purgeFile(f.alice.token,initial.fileId),{statusCode:409})
    assert.equal((await f.files.usage(f.alice.token)).storedBytes,bytes.length*2)
    await f.files.restoreFile(f.alice.token,initial.fileId)
    assert.deepEqual(await f.files.readFile(f.alice.token,initial.fileId,initial.revision),bytes)
  }finally{release();await receiving}
})
