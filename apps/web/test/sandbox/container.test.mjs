import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { sandboxFixture } from '../helpers/native-sandbox.mjs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createApiShell } from '../../server/src/framework.ts'
import { registerHealthRoutes } from '../../server/src/modules/health/routes.ts'

async function noContainers() {
  const { stdout } = await promisify(execFile)('/usr/bin/docker',['ps','-aq','--filter','label=dyoffice.sandbox=true'])
  assert.equal(stdout.trim(),'','A sandbox container survived cleanup')
}
test('native process is nonroot, read only, capability-free and receives no controller credentials', { timeout: 20_000 },async () => {
  const runner = await sandboxFixture(), canary = 'test-only-native-environment-sentinel'
  process.env.DYOFFICE_TEST_CANARY = canary
  try {
    await runner.run(Buffer.from('private input'),async session => {
      const status = await session.request('probe',{})
      assert.equal(status.uid,10001); assert.equal(status.gid,10001)
      assert.equal(status.rootWritable,false); assert.equal(status.secretPresent,false)
      assert.equal(status.noNewPrivs,1); assert.equal(status.capEff,'0000000000000000')
      assert.equal(status.inputReadable,true)
      await assert.rejects(() => session.request('sh',{}),{ code: 'UNSUPPORTED_COMMAND' })
    })
    await noContainers()
  } finally { delete process.env.DYOFFICE_TEST_CANARY }
})
test('network namespace cannot reach the host API and process count is kernel-bounded', { timeout: 20_000 },async t => {
  let connections = 0
  const server = createServer((_request,response) => response.end('api-alive'))
  server.on('connection',() => connections++)
  await new Promise(resolve => server.listen(0,'0.0.0.0',resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  const runner = await sandboxFixture('probe',{ pids: 16 })
  await runner.run(Buffer.from('probe'),async session => {
    const network = await session.request('network',{ port: server.address().port })
    assert.equal(network.connected,false); assert.equal(connections,0)
    const pids = await session.request('pids',{})
    assert.ok(pids.forked>0 && pids.forked<16)
    assert.equal(pids.limited,true)
  })
  assert.equal(await (await fetch(`http://127.0.0.1:${server.address().port}`)).text(),'api-alive')
  await noContainers()
})
test('wall deadline, cancellation and output flood kill their container and leave API process alive', { timeout: 30_000 },async () => {
  const timed = await sandboxFixture('probe',{ wallMs: 1500 })
  await assert.rejects(() => timed.run(Buffer.from('probe'),session => session.request('sleep',{})),{ code: 'SANDBOX_TIMEOUT' })
  const cancel = await sandboxFixture(), controller = new AbortController()
  await assert.rejects(() => cancel.run(Buffer.from('probe'),async session => {
    const pending = session.request('sleep',{})
    controller.abort(); return pending
  },{ signal: controller.signal }),{ code: 'ABORTED' })
  const flooded = await sandboxFixture('probe',{ protocolBytes: 16384 })
  await assert.rejects(() => flooded.run(Buffer.from('probe'),session => session.request('flood',{})),{ code: 'OUTPUT_LIMIT' })
  await noContainers()
})
test('CPU and memory resource limits kill native processes without terminating the API process', { timeout: 30_000 },async t => {
  const app = await createApiShell()
  registerHealthRoutes(app,async () => true)
  await app.listen({ port: 0,host: '127.0.0.1' }); t.after(() => app.close())
  const health = async () => {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/v1/health/live`)
    assert.equal(response.status,200); assert.deepEqual(await response.json(),{ state: 'alive' })
  }
  const whileBusy = async (session,command) => {
    const pending = session.request(command,{}); void pending.catch(() => {})
    await health(); return pending
  }
  const cpu = await sandboxFixture('probe',{ cpuSeconds: 1,wallMs: 10_000 })
  await assert.rejects(() => cpu.run(Buffer.from('probe'),session => whileBusy(session,'busy')),{ code: 'RESOURCE_LIMIT' })
  const memory = await sandboxFixture('probe',{ memoryMiB: 64,wallMs: 10_000 })
  await assert.rejects(() => memory.run(Buffer.from('probe'),session => whileBusy(session,'allocate')),error => {
    assert.equal(error.code,'RESOURCE_LIMIT'); assert.equal(error.oomKilled,true); return true
  })
  await health()
  await noContainers()
})
test('output transfer reads one bounded regular file and rejects symlink substitution', { timeout: 20_000 },async () => {
  const runner = await sandboxFixture()
  const bytes = await runner.run(Buffer.from('probe'),async session => {
    await session.request('output',{}); return session.readOutput()
  })
  assert.deepEqual(bytes,Buffer.from('native-output'))
  await assert.rejects(() => runner.run(Buffer.from('probe'),async session => {
    await session.request('symlink',{}); return session.readOutput()
  }),{ code: 'INVALID_OUTPUT' })
  await noContainers()
})
test('admission is bounded and cancellation during startup releases all resources for the next job', { timeout: 20_000 },async () => {
  const runner = await sandboxFixture(), first = new AbortController(), second = new AbortController()
  const one = runner.run(Buffer.from('one'),session => session.request('sleep',{}),{ signal: first.signal }).catch(error => error)
  const two = runner.run(Buffer.from('two'),session => session.request('sleep',{}),{ signal: second.signal }).catch(error => error)
  await assert.rejects(() => runner.run(Buffer.from('third'),session => session.request('probe',{})),{ code: 'SANDBOX_BUSY' })
  first.abort(); second.abort()
  assert.equal((await one).code,'ABORTED'); assert.equal((await two).code,'ABORTED')
  assert.equal((await runner.run(Buffer.from('next'),session => session.request('probe',{}))).uid,10001)
  await noContainers()
})
