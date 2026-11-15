import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn,execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { mkdtemp,rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const exec = promisify(execFile)
const containers = async () => (await exec('/usr/bin/docker',['ps','-aq','--filter','label=dyoffice.sandbox=true'])).stdout.trim().split('\n').filter(Boolean)
test('controller SIGKILL during native sleep cannot leave a live or stopped container past its independent deadline',{ timeout: 20_000 },async t => {
  assert.deepEqual(await containers(),[])
  const directory = await mkdtemp(join(tmpdir(),'dyoffice-controller-crash-'))
  t.after(() => rm(directory,{ recursive: true,force: true }))
  const child = spawn(process.execPath,['--experimental-strip-types',fileURLToPath(new URL('../fixtures/park-native-controller.mjs',import.meta.url))],{ env: { ...process.env,TMPDIR: directory },stdio: ['ignore','pipe','pipe'] })
  let log = '',timer
  child.stderr.resume()
  const exited = new Promise(resolve => child.once('exit',resolve))
  t.after(async () => {
    clearTimeout(timer)
    if (child.exitCode===null && child.signalCode===null) { child.kill('SIGKILL'); await exited }
    const leftovers = await containers()
    if (leftovers.length) await exec('/usr/bin/docker',['rm','-f',...leftovers])
  })
  await new Promise((resolve,reject) => {
    timer = setTimeout(() => reject(new Error('Native crash fixture did not start')),8000)
    child.stdout.on('data',chunk => { log += chunk; if (log.includes('native-parked\n')) { clearTimeout(timer); resolve() } })
    child.once('error',reject); child.once('exit',() => reject(new Error('Native crash fixture exited before ready')))
  })
  assert.equal((await containers()).length,1)
  child.kill('SIGKILL'); await exited
  assert.equal(child.signalCode,'SIGKILL')
  const deadline = Date.now()+6000
  while ((await containers()).length && Date.now()<deadline) await new Promise(resolve => setTimeout(resolve,50))
  assert.deepEqual(await containers(),[],'Container survived controller death and its native deadline')
})
