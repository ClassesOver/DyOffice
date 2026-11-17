import { test } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { installControlledQa } from './shell.ts'
const turn = () => new Promise((r) => setImmediate(r))
function realm() {
  const dom = new JSDOM('<main></main>', { url: 'http://localhost:18768' })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  return dom
}
test('fresh page lifecycle ignores old async failure and retains localStorage pointer', async () => {
  const dom = realm(),
    instances = [],
    pointers = []
  dom.window.localStorage.setItem('dyoffice.t14.controlled.v1', 'opaque-do-not-clear')
  installControlledQa({
    main: document.querySelector('main'),
    fileId: 'f',
    getCsrfToken: async () => '',
    createController: ({ pointerStorage }) => {
      pointers.push(pointerStorage.getItem('dyoffice.t14.controlled.v1'))
      const listeners = new Set()
      let resolve, reject
      const promise = new Promise((a, b) => {
        resolve = a
        reject = b
      })
      const instance = {
        phase: 'opening',
        disposed: false,
        open: () => promise,
        snapshot: () => ({
          phase: instance.phase,
          message: 'new realm',
          fileId: 'f',
          paragraphs: ['safe'],
        }),
        subscribe: (fn) => {
          listeners.add(fn)
          return () => listeners.delete(fn)
        },
        dispose: () => {
          instance.disposed = true
        },
        finish: () => {
          instance.phase = 'ready'
          for (const f of listeners) f()
          resolve()
        },
        reject,
      }
      instances.push(instance)
      return instance
    },
  })
  window.dispatchEvent(new window.Event('pagehide'))
  window.dispatchEvent(new window.Event('pageshow'))
  assert.equal(instances.length, 2)
  assert.equal(instances[0].disposed, true)
  instances[0].reject(Error('old failure'))
  await turn()
  assert.match(document.querySelector('[role=status]').textContent, /opening/)
  assert.equal(document.querySelector('button').disabled, true)
  instances[1].finish()
  await turn()
  assert.equal(document.querySelector('button').disabled, false)
  assert.deepEqual(pointers, ['opaque-do-not-clear', 'opaque-do-not-clear'])
  assert.equal(window.localStorage.getItem('dyoffice.t14.controlled.v1'), 'opaque-do-not-clear')
  dom.window.close()
})
test('persistent storage denied blocks before controller or request construction', () => {
  const dom = realm()
  let calls = 0
  installControlledQa({
    main: document.querySelector('main'),
    fileId: 'f',
    getCsrfToken: async () => '',
    getStorage: () => {
      throw Error('denied')
    },
    createController: () => {
      calls++
      throw Error('should not create')
    },
  })
  assert.equal(calls, 0)
  assert.match(document.querySelector('[role=status]').textContent, /blocked/)
  assert.equal(
    [...document.querySelectorAll('button')].every((b) => b.disabled),
    true,
  )
  dom.window.close()
})
test('blocked other-file pointer exposes explicit recovery link without clearing or jumping', () => {
  const dom = realm(),
    fileId = '11111111-1111-4111-8111-111111111111',
    commandId = '22222222-2222-4222-8222-222222222222'
  const snapshot = {
    phase: 'blocked',
    message: 'Other file pointer exists',
    fileId: 'current',
    paragraphs: [],
    recovery: { fileId, commandId, profileVersion: 'lo-template-v1' },
  }
  installControlledQa({
    main: document.querySelector('main'),
    fileId: 'current',
    getCsrfToken: async () => '',
    createController: () => ({
      snapshot: () => snapshot,
      subscribe: () => () => {},
      open: async () => {},
      dispose: () => {},
    }),
  })
  const link = document.querySelector('a')
  assert.equal(link.hidden, false)
  assert.match(link.textContent, new RegExp(commandId))
  assert.equal(
    link.getAttribute('href'),
    `/qa/controlled/recovery?fileId=${fileId}&commandId=${commandId}`,
  )
  assert.equal(window.location.pathname, '/')
  dom.window.close()
})
test('save failure preserves recovery-required explanation instead of raw transport error', async () => {
  const dom = realm(),
    listeners = new Set(),
    fileId = '11111111-1111-4111-8111-111111111111',
    commandId = '22222222-2222-4222-8222-222222222222'
  let snapshot = {
    phase: 'applied_uncommitted',
    message: '等待保存',
    fileId,
    paragraphs: ['changed'],
  }
  installControlledQa({
    main: document.querySelector('main'),
    fileId,
    getCsrfToken: async () => '',
    createController: () => ({
      snapshot: () => snapshot,
      subscribe: (fn) => {
        listeners.add(fn)
        return () => listeners.delete(fn)
      },
      open: async () => {},
      dispose: () => {},
      save: async () => {
        snapshot = {
          ...snapshot,
          phase: 'recovery_required',
          message: '提交可能已生效。请查看恢复状态，不要重放修改。',
          recovery: { fileId, commandId, profileVersion: 'lo-template-v1' },
        }
        for (const fn of listeners) fn()
        throw Error('Web host operation request failed: UNAVAILABLE')
      },
    }),
  })
  await turn()
  ;[...document.querySelectorAll('button')].find((b) => b.textContent === '保存并核验收据').click()
  await turn()
  const message = document.querySelector('[role=status]').textContent
  assert.match(message, /recovery_required/)
  assert.match(message, /提交可能已生效/)
  assert.match(message, /不要重放/)
  assert.doesNotMatch(message, /UNAVAILABLE/)
  assert.equal(document.querySelector('a').hidden, false)
  assert.equal(
    [...document.querySelectorAll('button')].every((b) => b.disabled),
    true,
  )
  dom.window.close()
})
