import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

test('bootstrap CLI refuses noninteractive password injection without printing credentials', async () => {
  const file = fileURLToPath(new URL('../../../../tools/dyoffice/bootstrap-admin.ts', import.meta.url))
  await assert.rejects(
    promisify(execFile)(process.execPath, ['--experimental-strip-types', file], {
      env: { ...process.env, DYOFFICE_DATABASE_URL: 'postgresql://hidden:db-secret@127.0.0.1:1/unused', DYOFFICE_ADMIN_PASSWORD: 'injected-password-secret' },
    }),
    error => {
      assert.equal(error.code, 1)
      assert.match(error.stderr, /interactive terminal required/i)
      assert.equal(error.stderr.includes('db-secret'), false)
      assert.equal(error.stderr.includes('injected-password-secret'), false)
      return true
    },
  )
})
