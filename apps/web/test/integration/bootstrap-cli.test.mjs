import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { parseBootstrapArgs, readBootstrapPassword } from '../../tools/bootstrap-admin.mjs'

test('admin bootstrap refuses password options and requires explicit account coordinates', () => {
  const args = parseBootstrapArgs(['--deployment-id','11111111-1111-4111-8111-111111111111','--username','admin.local','--password-stdin'])
  assert.equal(args.passwordStdin, true)
  assert.equal(args.username, 'admin.local')
  for (const invalid of [
    ['--password','plaintext'],
    ['--deployment-id','1','--username','u','--password','plaintext'],
    ['--deployment-id','1'],
    ['--deployment-id','1','--username','u','--username','v'],
    ['--deployment-id','1','--username','u','--password-stdin','--password-stdin'],
  ]) assert.throws(() => parseBootstrapArgs(invalid))
})

test('password-stdin reads one secret without echoing or normalizing whitespace', async () => {
  const input = new PassThrough()
  const output = new PassThrough()
  input.end('  long unusual passphrase  \n')
  const password = await readBootstrapPassword({passwordStdin:true},input,output)
  assert.equal(password,'  long unusual passphrase  ')
  assert.equal(output.read(),null)
})

test('password-stdin rejects embedded newlines and overlong input', async () => {
  for(const value of ['password1\npassword2\n','x'.repeat(1026)+'\n']){
    const input = new PassThrough()
    input.end(value)
    await assert.rejects(readBootstrapPassword({passwordStdin:true},input),/one line|too long/)
  }
})
