import test from 'node:test'
import assert from 'node:assert/strict'
import { DbhubPool } from '../../server/src/modules/sources/dbhub-pool.ts'

test('one concurrent startup per identity, no sharing between sources, bounded capacity', async () => {
  const pool = new DbhubPool(2)
  let opened = 0, closed = 0, release
  const gate = new Promise(resolve => { release = resolve })
  const open = async () => { const id = ++opened; await gate; return { id, close: async () => { closed++ } } }
  const run = key => pool.use(key, open, c => c.id)
  const pending = [run('a'),run('a'),run('b')]
  await assert.rejects(run('c'), { statusCode: 429 })
  release()
  assert.deepEqual(await Promise.all(pending), [1,1,2])
  assert.equal(await run('c'), 3)
  await pool.close()
  assert.equal(closed, 3)
})

test('connection loss never replays SQL; a rejected statement keeps the healthy session', async () => {
  const pool = new DbhubPool()
  let calls = 0, opened = 0
  const open = async () => ({ id: ++opened, close: async () => {} })
  for (const err of [Object.assign(Error(), {statusCode:400}), Error('disconnected')]) {
    await assert.rejects(pool.use('a', open, () => { calls++; throw err }))
    assert.equal(opened, 1)
  }
  assert.equal(await pool.use('a', open, c => c.id), 2)
  assert.equal(calls, 2)
  await pool.close()
})

test('idle sessions close and a later request reconnects', async () => {
  const pool = new DbhubPool(2, 5)
  let closed = 0
  const open = async () => ({close:async () => { closed++ }})
  await pool.use('a', open, () => {})
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(closed, 1)
  await pool.use('a', open, () => {})
  await pool.close()
  assert.equal(closed, 2)
})
