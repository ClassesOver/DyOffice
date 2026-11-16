import {test} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {spawn} from 'node:child_process'
import {PDFDocument} from 'pdf-lib'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {password} from '../helpers/identity.mjs'
import {createLeaseService} from '../../server/src/modules/leases/service.ts'
import {createRevisionService} from '../../server/src/modules/revisions/service.ts'
import {createPdfRotationJob} from '../../server/src/pdf/rotation-job.mjs'
import {createPdfSavePreparation} from '../../server/src/pdf/save-preparation.mjs'
import {createPdfReceiptRecovery} from '../../server/src/pdf/receipt-recovery.mjs'

const moduleUrl=path=>new URL('../../server/src/'+path,import.meta.url).href
async function fixture(t){
  const f=await fileFixture(t),doc=await PDFDocument.create();doc.addPage([200,100])
  const original=(await importFile(f,f.alice.token,Buffer.from(await doc.save()),'recovery.pdf')).file
  const leases=createLeaseService({transactions:f.transactions}),revisions=createRevisionService({transactions:f.transactions,objects:f.objects,files:f.files})
  const editorId=randomUUID(),lease=await leases.acquireLease(f.alice.token,original.fileId,{editorId}),key=randomUUID()
  const prepared=await createPdfSavePreparation({files:f.files,leases,revisions,processor:createPdfRotationJob()}).prepare({token:f.alice.token,fileId:original.fileId,baseRevision:original.revision,editorId,leaseEpoch:lease.leaseEpoch,idempotencyKey:key,request:JSON.stringify({version:1,action:'rotatePages',operations:[{page:1,degrees:90}]})})
  return {...f,original,key,prepared,revisions,leases}
}
async function child(f,action,token=f.alice.token){
  const script=`import {Pool} from 'pg';
    import {createPrincipalTransactions} from ${JSON.stringify(moduleUrl('db/context.ts'))};
    import {createPdfReceiptRecovery} from ${JSON.stringify(moduleUrl('pdf/receipt-recovery.mjs'))};
    import {createLocalObjectStore} from ${JSON.stringify(moduleUrl('storage/local-dev.ts'))};
    import {createFileService} from ${JSON.stringify(moduleUrl('modules/files/service.ts'))};
    import {createRevisionService} from ${JSON.stringify(moduleUrl('modules/revisions/service.ts'))};
    let raw='';for await(const b of process.stdin)raw+=b;const p=JSON.parse(raw);
    const pool=new Pool({connectionString:p.url}),transactions=createPrincipalTransactions({pool,deploymentId:p.deploymentId});
    try{if(p.action==='commit-and-exit'){const objects=await createLocalObjectStore({directory:p.directory});const files=createFileService({transactions,objects});await createRevisionService({transactions,objects,files}).commitRevision(p.token,p.commitInput);process.exit(73)}
    const result=await createPdfReceiptRecovery({transactions,token:p.token}).lookup(p.fileId,p.key);process.stdout.write(JSON.stringify(result));}
    catch(e){process.stdout.write(JSON.stringify({error:e.statusCode??e.code??'ERROR'}));process.exitCode=1}
    finally{await pool.end()}`
  return new Promise((resolve,reject)=>{
    const proc=spawn(process.execPath,['--import','tsx','--input-type=module','-e',script],{cwd:new URL('../..',import.meta.url),stdio:['pipe','pipe','pipe']})
    const timer=setTimeout(()=>{proc.kill('SIGKILL');reject(Error('Synthetic child deadline'))},30000)
    let out='';proc.stdout.on('data',b=>out+=b);proc.stderr.resume();proc.on('error',error=>{clearTimeout(timer);reject(error)})
    proc.on('close',code=>{clearTimeout(timer);try{resolve({code,result:out?JSON.parse(out):null})}catch(error){reject(error)}})
    proc.stdin.end(JSON.stringify({action,url:f.urls.business,deploymentId:f.deploymentId,directory:f.directory,token,commitInput:f.prepared.commitInput,fileId:f.original.fileId,key:f.key}))
  })
}
const counts=async f=>(await f.ownerPool.query('SELECT (SELECT count(*) FROM uploads)::int uploads,(SELECT count(*) FROM file_revisions)::int revisions,(SELECT count(*) FROM revision_commits)::int commits')).rows[0]

test('fresh Node process recovers commit after original process exits before acknowledgement without any business writes',async t=>{
  const f=await fixture(t)
  assert.deepEqual(await child(f,'commit-and-exit'),{code:73,result:null})
  const before=await counts(f),head=(await f.files.openFile(f.alice.token,f.original.fileId)).file
  const recovered=await child(f,'lookup')
  assert.equal(recovered.code,0);assert.equal(recovered.result.state,'committed')
  assert.deepEqual(recovered.result.revision,head)
  assert.deepEqual(await counts(f),before)
})

test('uncommitted and unknown keys remain unresolved and never rotate/upload/commit',async t=>{
  const f=await fixture(t),before=await counts(f),recovery=createPdfReceiptRecovery({transactions:f.transactions,token:f.alice.token})
  assert.deepEqual(await recovery.lookup(f.original.fileId,f.key),{state:'unresolved'})
  assert.deepEqual(await recovery.lookup(f.original.fileId,randomUUID()),{state:'unresolved'})
  assert.deepEqual(await counts(f),before)
  assert.equal((await f.files.openFile(f.alice.token,f.original.fileId)).file.revision,f.original.revision)
})

test('cross-user enumeration and revoked sessions are rejected rather than reporting receipt presence',async t=>{
  const f=await fixture(t);await f.revisions.commitRevision(f.alice.token,f.prepared.commitInput)
  const bob=createPdfReceiptRecovery({transactions:f.transactions,token:f.bob.token})
  for(const key of [f.key,randomUUID()])await assert.rejects(bob.lookup(f.original.fileId,key),e=>e.statusCode===404)
  await assert.rejects(createPdfReceiptRecovery({transactions:f.transactions,token:f.adminSigned.token}).lookup(f.original.fileId,f.key),e=>e.statusCode===404)
  await f.sessions.logout(f.alice.token)
  assert.equal((await child(f,'lookup')).result.error,401)
  const fresh=await f.sessions.login('alice',password)
  assert.equal((await child(f,'lookup',fresh.token)).result.state,'committed')
})

test('a later head does not hide historical committed receipt, but trash blocks recovery',async t=>{
  const f=await fixture(t),saved=await f.revisions.commitRevision(f.alice.token,f.prepared.commitInput)
  const editorId=randomUUID(),old=await f.leases.getLease(f.alice.token,f.original.fileId)
  const lease=await f.leases.takeoverLease(f.alice.token,f.original.fileId,{editorId,expectedEpoch:old.leaseEpoch})
  const next=await createPdfSavePreparation({files:f.files,leases:f.leases,revisions:f.revisions,processor:createPdfRotationJob()}).prepare({token:f.alice.token,fileId:saved.fileId,baseRevision:saved.revision,editorId,leaseEpoch:lease.leaseEpoch,idempotencyKey:randomUUID(),request:JSON.stringify({version:1,action:'rotatePages',operations:[{page:1,degrees:90}]})})
  const newest=await f.revisions.commitRevision(f.alice.token,next.commitInput)
  const before=await counts(f),recovery=createPdfReceiptRecovery({transactions:f.transactions,token:f.alice.token})
  assert.deepEqual(await recovery.lookup(saved.fileId,f.key),{state:'committed',revision:saved})
  assert.equal((await f.files.openFile(f.alice.token,saved.fileId)).file.revision,newest.revision)
  assert.deepEqual(await counts(f),before)
  await f.files.trashFile(f.alice.token,saved.fileId)
  await assert.rejects(recovery.lookup(saved.fileId,f.key),e=>e.statusCode===404)
})
