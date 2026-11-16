import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileFixture,importFile } from '../helpers/files.mjs'
import { createCsrfService } from '../../server/src/modules/auth/csrf.ts'
import { restrictedOrigin } from '../helpers/restricted.mjs'
const url = '/api/v1/jobs'
const headers = (f,token = f.alice.token) => ({ cookie: '__Host-dyoffice-session=' + token,origin: restrictedOrigin,'x-csrf-token': createCsrfService({ db: f.db,deploymentId: f.deploymentId,origin: restrictedOrigin,key: f.csrfKey }).sessionToken(token) })
async function setup(t,nativeJobs = true) {
  const f = await fileFixture(t,{ nativeJobs })
  const file = await importFile(f,f.alice.token,await readFile(new URL('../../../shell/build/shell-new/blank.xlsx',import.meta.url)),'job-route.xlsx')
  return { ...f,file: file.file,payload: { type: 'xlsx.roundtrip',input: { artifactId: file.file.revision },idempotencyKey: randomUUID() } }
}
test('experimental Cookie job API enqueues idempotently, lists and cancels owned SQL jobs without Redis',async t => {
  const f = await setup(t)
  const created = await f.app.inject({ method: 'POST',url,headers: headers(f),payload: f.payload })
  assert.equal(created.statusCode,202)
  const job = created.json(), path = url + '/' + job.id
  assert.equal(created.headers.location,path); assert.equal(job.state,'queued')
  assert.equal(job.fileId,f.file.fileId); assert.equal(job.artifactId,f.file.revision)
  assert.deepEqual((await f.app.inject({ method: 'POST',url,headers: headers(f),payload: f.payload })).json(),job)
  const got = await f.app.inject({ method: 'GET',url: path,headers: headers(f) })
  assert.equal(got.statusCode,200); assert.deepEqual(got.json(),job)
  assert.equal(got.headers['cache-control'],'private, no-store')
  const list = await f.app.inject({ method: 'GET',url,headers: headers(f) })
  assert.equal(list.statusCode,200); assert.deepEqual(list.json(),{ jobs: [job] })
  for (const secret of ['claim_hash','claim_epoch','sessionId','ownerId','objectKey','authVersion','request_hash','/objects/']) assert.equal(list.body.includes(secret),false)
  const cancel = await f.app.inject({ method: 'POST',url: path + '/cancel',headers: headers(f) })
  assert.equal(cancel.statusCode,200); assert.equal(cancel.json().state,'cancelled')
  assert.deepEqual((await f.app.inject({ method: 'POST',url: path + '/cancel',headers: headers(f) })).json(),cancel.json())
})
test('job API rejects cross-owner, cross-site, forged identity and unsupported executor requests',async t => {
  const f = await setup(t)
  const job = (await f.app.inject({ method: 'POST',url,headers: headers(f),payload: f.payload })).json()
  for (const token of [f.bob.token,f.adminSigned.token]) {
    for (const request of [{ method: 'GET',url: url + '/' + job.id },{ method: 'POST',url: url + '/' + job.id + '/cancel' },{ method: 'POST',url,payload: { ...f.payload,idempotencyKey: randomUUID() } }]) assert.equal((await f.app.inject({ ...request,headers: headers(f,token) })).statusCode,404)
    assert.deepEqual((await f.app.inject({ method: 'GET',url,headers: headers(f,token) })).json(),{ jobs: [] })
  }
  assert.equal((await f.app.inject({ method: 'GET',url })).statusCode,401)
  for (const bad of [{ ...headers(f),origin: 'https://evil.example' },{ cookie: headers(f).cookie,origin: restrictedOrigin },{ ...headers(f),'x-csrf-token': headers(f,f.bob.token)['x-csrf-token'] }]) assert.equal((await f.app.inject({ method: 'POST',url,headers: bad,payload: f.payload })).statusCode,403)
  assert.equal((await f.app.inject({ method: 'GET',url,headers: { ...headers(f),'sec-fetch-site': 'cross-site' } })).statusCode,403)
  for (const payload of [{ ...f.payload,ownerId: f.bob.user.id },{ ...f.payload,input: { ...f.payload.input,path: '/etc/passwd' } },{ ...f.payload,type: 'docx.roundtrip' },{ ...f.payload,type: 'shell.exec' }]) assert.equal((await f.app.inject({ method: 'POST',url,headers: headers(f),payload })).statusCode,400)
  assert.equal((await f.app.inject({ method: 'GET',url: url + '?owner=' + f.alice.user.id,headers: headers(f) })).statusCode,400)
  assert.equal((await f.app.inject({ method: 'POST',url: url + '/' + job.id + '/cancel',headers: headers(f),payload: { epoch: 1 } })).statusCode,400)
  await f.sessions.revoke(f.alice.token,f.alice.sessionId)
  assert.equal((await f.app.inject({ method: 'GET',url,headers: headers(f) })).statusCode,401)
})
test('job HTTP routes stay disabled without explicit experimental configuration',async t => {
  const f = await setup(t,false)
  for (const request of [{ method: 'GET',url },{ method: 'POST',url,payload: f.payload }]) assert.equal((await f.app.inject({ ...request,headers: headers(f) })).statusCode,501)
})

test('real server entry enables job API from explicit local configuration without a Redis connection',{ timeout: 25_000 },async t => {
  const f = await setup(t), child = spawn(process.execPath,['--experimental-strip-types',fileURLToPath(new URL('../../server/index.mjs',import.meta.url))],{
    env: { PATH: process.env.PATH,NODE_ENV: 'test',HOST: '127.0.0.1',PORT: '0',DYOFFICE_AUTH_MODE: 'local',DYOFFICE_NATIVE_JOBS: 'experimental',DYOFFICE_AUTH_DATABASE_URL: f.urls.auth,DYOFFICE_BUSINESS_DATABASE_URL: f.urls.business,DYOFFICE_DEPLOYMENT_ID: f.deploymentId,DYOFFICE_ORIGIN: restrictedOrigin,DYOFFICE_CSRF_KEY: f.csrfKey,DYOFFICE_FILE_API: 'experimental',DYOFFICE_OBJECT_STORE: 'local-dev',DYOFFICE_OBJECT_DIRECTORY: f.directory },stdio: ['ignore','pipe','pipe'],
  })
  const exited = new Promise(resolve => child.once('exit',resolve))
  let stdout = '',stderr = '',timer
  child.stderr.on('data',chunk => { stderr += chunk })
  try {
    const address = await new Promise((resolve,reject) => {
      timer = setTimeout(() => reject(new Error('Actual API entry did not become ready')),12000)
      child.once('error',reject); child.once('exit',() => reject(new Error('Actual API entry exited before ready')))
      child.stdout.on('data',chunk => { stdout += chunk; const match = /dyoffice: (http:\/\/127\.0\.0\.1:\d+)/.exec(stdout); if (match) { clearTimeout(timer); resolve(match[1]) } })
    })
    const created = await fetch(address + url,{ method: 'POST',headers: { ...headers(f),'content-type': 'application/json' },body: JSON.stringify(f.payload) })
    assert.equal(created.status,202); const job = await created.json()
    const got = await fetch(address + url + '/' + job.id,{ headers: headers(f) })
    assert.equal(got.status,200); assert.deepEqual(await got.json(),job); assert.equal(job.state,'queued')
  } finally {
    clearTimeout(timer)
    if (child.exitCode===null && child.signalCode===null) {
      child.kill('SIGTERM')
      const kill = setTimeout(() => child.kill('SIGKILL'),5000)
      try { assert.equal(await exited,0) } finally { clearTimeout(kill) }
    }
  }
  assert.equal(stderr,'')
})
