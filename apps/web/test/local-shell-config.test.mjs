import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { localShellDirectory } from '../server/local-shell-config.mjs'

test('local shell has no development fallback or implicit enablement', () => {
  assert.equal(localShellDirectory({}), undefined)
  assert.equal(localShellDirectory({ DYOFFICE_AUTH_MODE: 'local' }), undefined)
  for (const env of [
    { DYOFFICE_LOCAL_SHELL: 'experimental', DYOFFICE_LOCAL_SHELL_DIR: '/tmp/shell' },
    { DYOFFICE_AUTH_MODE: 'local', DYOFFICE_LOCAL_SHELL: 'on', DYOFFICE_LOCAL_SHELL_DIR: '/tmp/shell' },
    { DYOFFICE_AUTH_MODE: 'local', DYOFFICE_LOCAL_SHELL: 'experimental' },
    { DYOFFICE_AUTH_MODE: 'local', DYOFFICE_LOCAL_SHELL_DIR: '/tmp/shell' },
    { DYOFFICE_AUTH_MODE: 'local', DYOFFICE_LOCAL_SHELL: 'experimental', DYOFFICE_LOCAL_SHELL_DIR: fileURLToPath(new URL('../dist', import.meta.url)) },
  ]) assert.throws(() => localShellDirectory(env), /local shell/i)
})
test('local shell requires explicit local experimental mode and directory', () => {
  assert.equal(localShellDirectory({ DYOFFICE_AUTH_MODE: 'local', DYOFFICE_LOCAL_SHELL: 'experimental', DYOFFICE_LOCAL_SHELL_DIR: './apps/web/dist-local-shell' }), resolve('./apps/web/dist-local-shell'))
})
