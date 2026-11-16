import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { startNativeWorker } from '../../worker/src/main.ts'

for (const backend of [undefined,'local-dev','unknown']) test(`native worker refuses ${backend ?? 'missing'} storage before connecting to dependencies`,async t => {
  let connections=0
  const server=createServer(socket => { connections++; socket.destroy() })
  server.listen(0,'127.0.0.1'); await once(server,'listening')
  t.after(() => new Promise(resolve => server.close(resolve)))
  const port=server.address().port
  const environment={ NODE_ENV: 'test',DYOFFICE_NATIVE_WORKER: 'experimental',DYOFFICE_DEPLOYMENT_ID: randomUUID(),DYOFFICE_WORKER_DATABASE_URL: `postgres://worker@127.0.0.1:${port}/test`,DYOFFICE_BUSINESS_DATABASE_URL: `postgres://business@127.0.0.1:${port}/test`,DYOFFICE_REDIS_URL: `redis://127.0.0.1:${port}`,DYOFFICE_NATIVE_BINARY: '/unused/native',DYOFFICE_NATIVE_SHA256: '0'.repeat(64),DYOFFICE_FILE_API: 'experimental',DYOFFICE_OBJECT_STORE: backend,DYOFFICE_OBJECT_DIRECTORY: '/unused/objects' }
  await assert.rejects(() => startNativeWorker(environment),/Native worker requires S3 object storage/)
  assert.equal(connections,0)
})
