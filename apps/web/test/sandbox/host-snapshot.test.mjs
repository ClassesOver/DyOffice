import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { syncBuiltinESMExports } from 'node:module'
import { promisify } from 'node:util'
import childProcess from 'node:child_process'
import fs from 'node:fs/promises'
import { readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Preparation regression only: stop at the systemd-run boundary and inspect
// the actual staged files. This does not execute or emulate a sandbox, and is
// deliberately runnable without root. Kernel isolation has separate root tests.
test('host preparation always verifies the staged snapshot and never shares host inodes', async t => {
  const directory = await fs.mkdtemp(join(tmpdir(),'host-snapshot-'))
  const originalExec = childProcess.execFile
  const library = join(directory,'fixture-library')
  await fs.copyFile('/usr/lib/x86_64-linux-gnu/libc.so.6',library)
  const captured = []
  mock.method(process,'getuid',() => 0)
  const execute = (command,args) => {
    assert.ok(['/usr/bin/systemctl','/usr/bin/ldd'].includes(command))
    return { stdout: command === '/usr/bin/ldd' ? library+'\n' : 'MainPID=0\nActiveState=inactive\n',stderr: '' }
  }
  const execStub = (command,args,options,callback) => {
    const result = execute(command,args)
    queueMicrotask(() => callback(null,result.stdout,result.stderr))
    return { stdout: null,stderr: null }
  }
  execStub[promisify.custom] = async (command,args) => execute(command,args)
  childProcess.execFile = execStub
  mock.method(childProcess,'spawn',(command,args) => {
    assert.equal(command,'/usr/bin/systemd-run')
    const root = args.find(value => value.startsWith('--property=RootDirectory=')).slice('--property=RootDirectory='.length)
    const binary = join(root,'bin/native'), stat = statSync(binary)
    const libraryStat = statSync(join(root,library)), sourceLibrary = statSync(library)
    captured.push({ root,bytes: readFileSync(binary),ino: stat.ino,dev: stat.dev,nlink: stat.nlink,libraryIndependent: libraryStat.dev !== sourceLibrary.dev || libraryStat.ino !== sourceLibrary.ino })
    throw new Error('controlled stop before starting a service')
  })
  syncBuiltinESMExports()
  try {
    const { createHostProcess } = await import('../../worker/src/sandbox/host-process.ts')
    const original = await fs.readFile('/usr/bin/true')
    const sha256 = createHash('sha256').update(original).digest('hex')
    const runner = binary => createHostProcess({ binary,sha256,deploymentId: randomUUID(),allowedCommands: ['probe'] })
    const prepare = async host => {
      await assert.rejects(() => host.run(Buffer.from('input'),async () => { throw new Error('service must never execute') }),{ code: 'HOST_BACKEND_UNAVAILABLE' })
      return captured.at(-1)
    }
    await t.test('binary and every staged library have independent inodes',async () => {
      const binary = join(directory,'native-inodes');await fs.writeFile(binary,original,{ mode: 0o555 })
      const stat = await fs.stat(binary), staged = await prepare(runner(binary))
      assert.deepEqual(staged.bytes,original)
      assert.ok(staged.dev !== stat.dev || staged.ino !== stat.ino,'binary must not share the source inode')
      assert.equal(staged.nlink,1)
      assert.equal(staged.libraryIndependent,true,'libraries must not share host inodes')
    })
    await t.test('same-size mutation with restored mtime cannot reuse a previous hash',async () => {
      const binary = join(directory,'native-mtime');await fs.writeFile(binary,original,{ mode: 0o755 })
      const stamp = new Date('2026-01-01T00:00:00.000Z');await fs.utimes(binary,stamp,stamp)
      const host = runner(binary);await prepare(host)
      const changed = Buffer.from(original);changed[changed.length-1] ^= 1
      await fs.writeFile(binary,changed);await fs.utimes(binary,stamp,stamp)
      await assert.rejects(() => host.run(Buffer.from('input'),async () => {}),{ code: 'UNTRUSTED_BINARY' })
    })
    await t.test('path replacement after verification cannot change the bytes published',async () => {
      const binary = join(directory,'native-race');await fs.writeFile(binary,original,{ mode: 0o755 })
      const changed = Buffer.from(original);changed[changed.length-1] ^= 1
      const mkdir = fs.mkdir;let replaced = false
      const intercept = mock.method(fs,'mkdir',async (path,...args) => {
        if (!replaced && typeof path === 'string' && /^\/var\/tmp\/dyoffice-[^/]+$/.test(path)) {
          replaced=true
          const other=join(directory,'replacement');await fs.writeFile(other,changed,{ mode: 0o755 });await fs.rename(other,binary)
        }
        return mkdir(path,...args)
      })
      syncBuiltinESMExports()
      try {
        const staged = await prepare(runner(binary))
        assert.equal(replaced,true)
        assert.deepEqual(staged.bytes,original,'publish the verified FD snapshot, never reopen the mutable source path')
      } finally { intercept.mock.restore();syncBuiltinESMExports() }
    })
  } finally {
    childProcess.execFile = originalExec
    mock.restoreAll();syncBuiltinESMExports()
    await fs.rm(directory,{ recursive: true,force: true })
  }
})
