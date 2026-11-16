import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { fileFixture, docxBytes, importFile } from '../helpers/files.mjs'
import { s3Fixture } from '../helpers/s3.mjs'
import { restrictedOrigin } from '../helpers/restricted.mjs'
import { createCsrfService } from '../../server/src/modules/auth/csrf.ts'
import { createLeaseService } from '../../server/src/modules/leases/service.ts'

for (const kind of ['import','revision']) test(`${kind} staging bounds actual cross-owner garbage collection and releases admission`, {timeout: 15000}, async t => {
  let paused = false, active = 0, peak = 0, enter, release
  const entered = new Promise(r => { enter = r }), gate = new Promise(r => { release = r })
  t.after(() => release())
  const objectStore = process.env.DYOFFICE_TEST_RECLAMATION_STORE === 's3' ? (await s3Fixture(t)).store : undefined
  const f = await fileFixture(t, {objectStore,wrapObjects:store=>({...store,async removeUnreferenced(key){
    active++; peak=Math.max(peak,active); if(paused&&active===2)enter()
    try { if(paused)await gate; await store.removeUnreferenced(key) } finally {active--}
  }})})
  const bytes = await docxBytes(), users = [f.alice,f.bob,f.adminSigned], requests=[]
  const leases = createLeaseService({transactions:f.transactions})
  const csrf = createCsrfService({db:f.db,deploymentId:f.deploymentId,origin:restrictedOrigin,key:f.csrfKey})
  for (const user of users) {
    let url='/api/v1/files/uploads',payload={name:'new.docx',size:bytes.length}
    if(kind==='revision'){
      const file=(await importFile(f,user.token,bytes)).file,editorId=randomUUID()
      const lease=await leases.acquireLease(user.token,file.fileId,{editorId})
      url=`/api/v1/files/${file.fileId}/uploads`;payload={baseRevision:file.revision,leaseEpoch:lease.leaseEpoch,editorId,size:bytes.length}
    }
    const abandoned=await f.files.stageUpload(user.token,{name:'abandoned.docx',size:bytes.length})
    await f.files.receiveUpload(user.token,abandoned.uploadId,bytes)
    await f.files.cancelUpload(user.token,abandoned.uploadId)
    requests.push({method:'POST',url,payload,headers:{origin:restrictedOrigin,cookie:'__Host-dyoffice-session='+user.token,'x-csrf-token':csrf.sessionToken(user.token)}})
  }
  paused=true
  const pending=[f.app.inject(requests[0]),f.app.inject(requests[1])]
  let third, thirdPending
  try {
    await entered;thirdPending=f.app.inject(requests[2])
    third=await Promise.race([thirdPending,new Promise(r=>setTimeout(()=>r(null),500))])
  } finally {release()}
  const responses=await Promise.all(pending)
  await thirdPending
  assert.equal(third?.statusCode,503);assert.equal(peak,2)
  assert.deepEqual(responses.map(r=>r.statusCode),[201,201])
  assert.equal((await f.app.inject(requests[2])).statusCode,201)
})
