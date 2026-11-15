import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createStore } from '../server/store.mjs'

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dyoffice-store-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return { directory, store: await createStore(directory, 'test-only-key') }
}

test('an asynchronous update must persist the same snapshot exposed in memory', async t => {
  const { directory, store } = await fixture(t)
  await store.update(async next => {
    await Promise.resolve()
    next.preferences.theme = 'dark'
  })
  assert.equal(store.read().preferences.theme, 'dark')
  const disk = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'))
  assert.deepEqual(disk, store.read())
  const reopened = await createStore(directory, 'test-only-key')
  assert.equal(reopened.read().preferences.theme, 'dark')
})

test('a failed disk write preserves committed state and does not poison the queue', async t => {
  const { directory, store } = await fixture(t)
  await store.update(next => { next.preferences.theme = 'dark' })
  const before = await readFile(join(directory, 'state.json'))
  await mkdir(join(directory, 'state.json.tmp'))
  await assert.rejects(store.update(next => { next.preferences.theme = 'light' }), { code: 'EISDIR' })
  assert.equal(store.read().preferences.theme, 'dark')
  assert.deepEqual(await readFile(join(directory, 'state.json')), before)
  await rm(join(directory, 'state.json.tmp'), { recursive: true })
  await store.update(next => { next.preferences.language = 'en' })
  assert.deepEqual(store.read().preferences, { theme: 'dark', language: 'en' })
})

test('queued updates see prior commits and mutator failures leave no partial changes', async t => {
  const { directory, store } = await fixture(t)
  await assert.rejects(store.update(next => {
    next.preferences.theme = 'light'
    throw new Error('abort this update')
  }), /abort this update/)
  assert.equal(store.read().preferences.theme, 'system')
  await Promise.all(Array.from({ length: 12 }, (_, n) => store.update(next => { next.files.push({ id: String(n) }) })))
  assert.deepEqual(store.read().files.map(file => file.id), Array.from({ length: 12 }, (_, n) => String(n)))
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')), store.read())
})

test('a rejected async mutator rolls back memory and disk, then later updates recover', async t => {
  const { directory, store } = await fixture(t)
  await store.update(next => { next.preferences.language = 'en' })
  const before = await readFile(join(directory, 'state.json'))
  await assert.rejects(store.update(async next => {
    next.preferences.theme = 'dark'
    await Promise.resolve()
    throw new Error('async update failed')
  }), /async update failed/)
  assert.deepEqual(store.read().preferences, { theme: 'system', language: 'en' })
  assert.deepEqual(await readFile(join(directory, 'state.json')), before)
  await store.update(next => { next.preferences.theme = 'light' })
  assert.equal(store.read().preferences.theme, 'light')
})

test('an update queued behind an async mutator cannot overtake its snapshot', async t => {
  const { directory, store } = await fixture(t)
  let release, entered
  const gate = new Promise(resolve => { release = resolve })
  const started = new Promise(resolve => { entered = resolve })
  const first = store.update(async next => {
    entered()
    await gate
    next.files.push({ id: 'first' })
  })
  await started
  const second = store.update(next => { next.files.push({ id: 'second' }) })
  assert.deepEqual(store.read().files, [])
  release()
  await Promise.all([first, second])
  assert.deepEqual(store.read().files, [{ id: 'first' }, { id: 'second' }])
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')), store.read())
})
