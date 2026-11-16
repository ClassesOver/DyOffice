import test from 'node:test'
import assert from 'node:assert/strict'
import { createApiShell } from '../server/src/framework.ts'
import { registerFileRoutes } from '../server/src/modules/files/routes.ts'
const id = '11111111-1111-4111-8111-111111111111'
for (const kind of ['import','revision']) test(`${kind} staging GC shares the two-slot object admission budget`, {timeout: 5000}, async () => {
  const app = await createApiShell()
  let active = 0, peak = 0, enter, release
  const entered = new Promise(r => { enter = r }), gate = new Promise(r => { release = r })
  const stageUpload = async () => { active++; peak = Math.max(peak, active); if (active === 2) enter(); await gate; active--; return { uploadId: id } }
  registerFileRoutes(app, { stageUpload }, { authenticate: async () => ({}) }, {originCheck(){},requireSession(){}}, { revisions: {stageUpload}, leases: {} })
  await app.ready()
  const send = i => app.inject({method:'POST',url:kind==='import'?'/api/v1/files/uploads':`/api/v1/files/${id}/uploads`,
    headers:{cookie:'__Host-dyoffice-session='+String.fromCharCode(97+i).repeat(43)},
    payload:kind==='import'?{name:'test.docx',size:10}:{baseRevision:id,leaseEpoch:1,editorId:id,size:10},
  }).then(r=>r.statusCode)
  const calls = [send(0),send(1)]
  try {
    await entered
    calls.push(send(2))
    await Promise.race([calls[2],new Promise(r=>setTimeout(r,100))])
  } finally { release(); await Promise.all(calls); await app.close() }
  assert.equal(peak,2)
  assert.deepEqual(await Promise.all(calls),[201,201,503])
})
