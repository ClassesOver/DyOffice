import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createSlidesMockServer} from './mock-slides-server.mjs'
import {createSessionFileHost} from '../../../../packages/browser-host/src/files.ts'

async function leasedHost(t, server, fetchImpl) {
  const host = createSessionFileHost({fetchImpl: fetchImpl ?? server.fetchImpl})
  t.after(() => host.dispose())
  await host.open(server.file().fileId)
  await host.acquireLease(server.file().fileId)
  return host
}

test('saveSlides stages the deck export server-side and commits it through the idempotent receipt protocol', async t => {
  const server = createSlidesMockServer({slideCount: 2})
  const seen = []
  const fetchImpl = async (path, init = {}) => {
    if (String(path).endsWith('/slides/uploads') || String(path).endsWith('/commits')) seen.push({path: String(path), body: init.body ? JSON.parse(init.body) : null})
    return server.fetchImpl(path, init)
  }
  const host = await leasedHost(t, server, fetchImpl)
  // The slides session exists server-side before any save (open route created it).
  const opened = await (await server.fetchImpl(`/api/v1/files/${server.file().fileId}/slides/open`, {method: 'POST', headers: {'content-type': 'application/json', 'x-csrf-token': server.csrfToken}, body: JSON.stringify({revision: server.file().revision, generation: 0})})).json()
  const base = server.file()
  const saved = await host.saveSlides(base.fileId, {revision: base.revision, generation: opened.generation})
  const head = server.file()
  assert.equal(saved.revision, head.revision)
  assert.equal(saved.sha256, head.sha256)
  assert.equal(saved.size, head.size)
  assert.deepEqual(saved.touchedEntries, [], 'the slides save receipt carries no changed-parts list yet')
  assert.equal(host.getState(base.fileId).status, 'idle')
  assert.equal(seen.length, 2)
  const [prepare, commit] = seen
  assert.equal(prepare.body.baseRevision, base.revision)
  assert.equal(typeof prepare.body.leaseEpoch, 'number')
  assert.equal(prepare.body.request.revision, base.revision)
  assert.equal(prepare.body.request.generation, opened.generation)
  assert.deepEqual(Object.keys(prepare.body.request).sort(), ['generation', 'revision'])
  assert.match(commit.body.uploadId, /^[0-9a-f-]{36}$/)
  assert.equal(commit.body.fileId, base.fileId)
  assert.equal(commit.body.baseRevision, base.revision)
  assert.match(commit.body.idempotencyKey, /^[0-9a-f-]{36}$/)
  assert.equal(typeof commit.body.leaseEpoch, 'number')
})

test('a lost commit reply marks the receipt unknown and reconcileSlides replays the exact same commit', async t => {
  const server = createSlidesMockServer({slideCount: 1})
  let lost = false
  const commits = []
  const fetchImpl = async (path, init = {}) => {
    const response = await server.fetchImpl(path, init)
    if (String(path).endsWith('/commits')) {
      commits.push(JSON.parse(init.body))
      if (!lost) {
        lost = true
        await response.arrayBuffer()
        throw new TypeError('controlled lost reply')
      }
    }
    return response
  }
  const host = await leasedHost(t, server, fetchImpl)
  const opened = await (await server.fetchImpl(`/api/v1/files/${server.file().fileId}/slides/open`, {method: 'POST', headers: {'content-type': 'application/json', 'x-csrf-token': server.csrfToken}, body: JSON.stringify({revision: server.file().revision, generation: 0})})).json()
  const base = server.file()
  await assert.rejects(() => host.saveSlides(base.fileId, {revision: base.revision, generation: 0}), {code: 'UNAVAILABLE'})
  assert.equal(host.getState(base.fileId).status, 'unknown')
  // A second save must not re-prepare the export while the receipt is unconfirmed.
  await assert.rejects(() => host.saveSlides(base.fileId, {revision: base.revision, generation: 0}), {code: 'UNAVAILABLE'})
  assert.equal(server.preparations(), 1)
  const saved = await host.reconcileSlides(base.fileId)
  assert.equal(saved.revision, server.file().revision)
  assert.equal(commits.length, 2)
  assert.deepEqual(commits[0], commits[1], 'reconciliation replays the identical idempotent commit')
  assert.equal(host.getState(base.fileId).status, 'idle')
  assert.equal(host.getState(base.fileId).revision.revision, saved.revision)
  // Clean state: like reconcileSheets, reconciliation without a pending receipt is refused.
  await assert.rejects(() => host.reconcileSlides(base.fileId), {code: 'INVALID_REVISION'})
})

test('saveSlides surfaces generation conflicts and never stages a second deck while pending', async t => {
  const server = createSlidesMockServer({slideCount: 1})
  const host = await leasedHost(t, server)
  const opened = await (await server.fetchImpl(`/api/v1/files/${server.file().fileId}/slides/open`, {method: 'POST', headers: {'content-type': 'application/json', 'x-csrf-token': server.csrfToken}, body: JSON.stringify({revision: server.file().revision})})).json()
  const base = server.file()
  // A stale generation (the session moved on) must reject as CONFLICT, not commit old bytes.
  await assert.rejects(() => host.saveSlides(base.fileId, {revision: base.revision, generation: 99}), {code: 'CONFLICT'})
  assert.equal(host.getState(base.fileId).status, 'conflict')
  assert.equal(host.getState(base.fileId).lease, null, 'a conflicted slides save revokes the lease')
  assert.equal(server.preparations(), 1)
  await assert.rejects(() => host.saveSlides(base.fileId, {sessionId: opened.sessionId, expectedGeneration: 0}), {code: 'CONFLICT'})
})

test('saveSlides requires an active lease and rejects without one', async t => {
  const server = createSlidesMockServer({slideCount: 1})
  const host = createSessionFileHost({fetchImpl: server.fetchImpl})
  t.after(() => host.dispose())
  await host.open(server.file().fileId)
  const base = server.file()
  await assert.rejects(() => host.saveSlides(base.fileId, {revision: base.revision, generation: 0}), {code: 'CONFLICT'})
  assert.equal(server.preparations(), 0, 'no export may start without lease authority')
})

test('saveSlides rechecks authorization after export staging before dispatching commit',async t=>{
 const server=createSlidesMockServer({slideCount:1});let allowed=true,commits=0
 const host=await leasedHost(t,server,async(path,init)=>{
  const response=await server.fetchImpl(path,init)
  if(String(path).endsWith('/slides/uploads'))allowed=false
  if(String(path).endsWith('/commits'))commits++
  return response
 })
 await server.fetchImpl(`/api/v1/files/${server.file().fileId}/slides/open`,{method:'POST',headers:{'content-type':'application/json','x-csrf-token':server.csrfToken},body:JSON.stringify({revision:server.file().revision,generation:0})})
 await assert.rejects(host.saveSlides(server.file().fileId,{revision:server.file().revision,generation:0},()=>allowed),{code:'UNAVAILABLE'})
 assert.equal(commits,0)
 assert.equal(host.getState(server.file().fileId).status,'idle')
})
