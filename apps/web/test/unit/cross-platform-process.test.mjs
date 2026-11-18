import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCrossPlatformProcess } from '../../worker/src/sandbox/cross-platform-process.ts'

async function fileSha256(path) {
  const bytes = await readFile(path)
  return createHash('sha256').update(bytes).digest('hex')
}

test('cross-platform process verifies hashes, runs isolated script roundtrip, and enforces 2-slot capacity', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dyoffice-cp-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const scriptPath = join(dir, 'worker.mjs')
  await writeFile(
    scriptPath,
    `
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
const workDir = process.env.DYOFFICE_WORK_DIR
for await (const chunk of process.stdin) {
  for (const line of String(chunk).split('\\n').filter(Boolean)) {
    const packet = JSON.parse(line)
    if (packet.command === 'gateway_package') {
      const partName = packet.path.slice('/work/'.length)
      const part = await readFile(join(workDir, partName), 'utf8')
      const input = await readFile(join(workDir, 'input.xlsx'), 'utf8')
      await writeFile(join(workDir, 'output.xlsx'), JSON.stringify({ input, part }))
      process.stdout.write(JSON.stringify({ version: 1, requestId: packet.requestId, ok: true, result: { written: true } }) + '\\n')
    }
  }
}
`,
  )
  const execSha = await fileSha256(process.execPath)
  const scriptSha = await fileSha256(scriptPath)
  const deploymentId = randomUUID()

  const badRunner = createCrossPlatformProcess({
    binary: process.execPath,
    sha256: execSha,
    deploymentId,
    script: { path: scriptPath, sha256: '0'.repeat(64) },
    allowedCommands: ['gateway_package'],
  })
  await assert.rejects(
    () => badRunner.run(Buffer.from('workbook-bytes'), async () => {}),
    { code: 'UNTRUSTED_BINARY' },
  )

  const runner = createCrossPlatformProcess({
    binary: process.execPath,
    sha256: execSha,
    deploymentId,
    script: { path: scriptPath, sha256: scriptSha },
    allowedCommands: ['gateway_package'],
  })

  const output = await runner.run(Buffer.from('workbook-bytes'), async io => {
    const partPath = await io.writePart(Buffer.from('part-payload'))
    assert.match(partPath, /^\/work\/part-[a-f0-9-]{36}$/)
    const reply = await io.request('gateway_package', { path: partPath })
    assert.deepEqual(reply, { written: true })
    return JSON.parse((await io.readOutput()).toString('utf8'))
  })
  assert.deepEqual(output, { input: 'workbook-bytes', part: 'part-payload' })

  let releaseHold
  const hold = new Promise(resolve => {
    releaseHold = resolve
  })
  const first = runner.run(Buffer.from('a'), () => hold)
  const second = runner.run(Buffer.from('b'), () => hold)
  await assert.rejects(
    () => runner.run(Buffer.from('c'), async () => {}),
    { code: 'SANDBOX_BUSY' },
  )
  releaseHold()
  await Promise.all([first, second])
})
