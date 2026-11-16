import { test } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import * as ui from '../../../../packages/browser-host/src/command-approval-panel.ts'
const proposal = {
  state: 'pending_approval',
  digest: 'a'.repeat(64),
  envelope: {
    commandId: 'c',
    fileId: 'f',
    baseRevision: 'r',
    editorGeneration: 1,
    leaseEpoch: 2,
    argsHash: 'b'.repeat(64),
    payload: { toolName: 'replace', arguments: { text: '<img src=x onerror=alert(1)>' } },
  },
}
test('panel renders untrusted arguments as text and requires explicit review then approval', async () => {
  assert.equal(typeof ui.mountCommandApprovalPanel, 'function')
  const dom = new JSDOM('<main></main>'),
    root = dom.window.document.querySelector('main')
  let approved = 0,
    executed = 0
  ui.mountCommandApprovalPanel(root, {
    proposal,
    approve: async () => {
      approved++
      return { ...proposal, state: 'approved' }
    },
    execute: async () => {
      executed++
      return { status: 'applied_uncommitted' }
    },
    cancel: async () => ({ ...proposal, state: 'cancelled' }),
  })
  assert.equal(root.querySelector('img'), null)
  const approve = root.querySelector('[data-action=approve]')
  assert.equal(approve.disabled, true)
  approve.click()
  assert.equal(approved, 0)
  const review = root.querySelector('input')
  review.checked = true
  review.dispatchEvent(new dom.window.Event('change'))
  approve.click()
  await new Promise((r) => setImmediate(r))
  assert.equal(approved, 1)
  assert.equal(executed, 0)
  root.querySelector('[data-action=execute]').click()
  await new Promise((r) => setImmediate(r))
  assert.equal(executed, 1)
  assert.match(root.textContent, /已应用，未保存/)
})
test('double click and disposal cannot dispatch a second approval or execute late', async () => {
  const dom = new JSDOM('<main></main>'),
    root = dom.window.document.querySelector('main')
  let resolve,
    count = 0
  const view = ui.mountCommandApprovalPanel(root, {
    proposal,
    approve: async () => {
      count++
      return new Promise((r) => (resolve = r))
    },
    execute: async () => {
      throw Error('must not execute')
    },
    cancel: async () => ({ ...proposal, state: 'cancelled' }),
  })
  const box = root.querySelector('input')
  box.checked = true
  box.dispatchEvent(new dom.window.Event('change'))
  const button = root.querySelector('[data-action=approve]')
  button.click()
  button.click()
  assert.equal(count, 1)
  view.dispose()
  resolve({ ...proposal, state: 'approved' })
  await new Promise((r) => setImmediate(r))
  assert.equal(root.children.length, 0)
})
