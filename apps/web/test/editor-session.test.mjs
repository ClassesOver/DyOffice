import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createEditorSession } from '../public/editor-controller.js'

const revision = { fileId: 'file-1', revision: 'sha256:' + 'a'.repeat(64), sha256: 'a'.repeat(64), size: 10 }
const nextRevision = { ...revision, revision: 'sha256:' + 'b'.repeat(64), sha256: 'b'.repeat(64) }

function deferred() {
  let resolve
  let reject
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail })
  return { promise, resolve, reject }
}

test('edits made during a docx save stay dirty and keep the newer text', async () => {
  const pending = deferred()
  let serverText = 'Hello'
  let commits = 0
  const session = createEditorSession({
    acquireLease: async () => ({ leaseEpoch: 2 }),
    readDocx: async () => ({ file: commits ? nextRevision : revision, leaseEpoch: 2, blocks: [{ docxIndex: 0, type: 'paragraph', text: serverText, editable: true }] }),
    commitDocx: async (_id, input) => {
      commits += 1
      assert.equal(input.blocks[0].text, 'Hello!')
      serverText = 'Hello!'
      return pending.promise
    },
    newKey: () => 'key-123456',
  })
  await session.open('file-1')
  session.updateBlock(0, 'Hello!')
  const saving = session.save()
  session.updateBlock(0, 'Hello!!')
  pending.resolve(nextRevision)
  const result = await saving
  assert.equal(result.ok, true)
  assert.equal(result.state.dirty, true)
  assert.equal(result.state.blocks[0].text, 'Hello!!')
  assert.equal(result.state.baseRevision, nextRevision.revision)
  assert.equal(commits, 1)
})

test('a paragraph inserted during a save is kept after the server projection returns', async () => {
  const pending = deferred()
  let commits = 0
  const session = createEditorSession({
    acquireLease: async () => ({ leaseEpoch: 2 }),
    readDocx: async () => ({
      file: commits ? nextRevision : revision,
      leaseEpoch: 2,
      blocks: [{ docxIndex: 0, type: 'paragraph', text: commits ? 'Hello!' : 'Hello', editable: true }],
    }),
    commitDocx: async () => {
      commits += 1
      return pending.promise
    },
    newKey: () => 'key-123456',
  })
  await session.open('file-1')
  session.updateBlock(0, 'Hello!')
  const saving = session.save()
  const inserted = session.insertParagraph()
  session.updateBlock(inserted.blocks.length - 1, 'New paragraph')
  pending.resolve(nextRevision)
  const result = await saving
  assert.equal(result.ok, true)
  assert.equal(result.state.blocks.at(-1).text, 'New paragraph')
  assert.equal(result.state.blocks.at(-1).docxIndex, undefined)
  assert.equal(result.state.dirty, true)
  assert.equal(commits, 1)
})

test('a structural save without a fresh projection blocks another save', async () => {
  let commits = 0
  const session = createEditorSession({
    acquireLease: async () => ({ leaseEpoch: 2 }),
    readDocx: async () => {
      if (commits) throw new Error('refresh failed')
      return { file: revision, leaseEpoch: 2, blocks: [
        { docxIndex: 0, type: 'paragraph', text: 'Keep', editable: true },
        { docxIndex: 1, type: 'paragraph', text: 'Drop', editable: true },
      ] }
    },
    commitDocx: async () => {
      commits += 1
      return nextRevision
    },
    newKey: () => 'key-123456',
  })
  await session.open('file-1')
  session.deleteBlock(1)
  const lost = await session.save()
  assert.equal(lost.unknown, true)
  assert.equal(lost.state.blocks.some(block => block.text === 'Drop' && block.deleted), true)
  const blocked = await session.save()
  assert.equal(blocked.unknown, true)
  assert.equal(commits, 1)
})

test('a conflict keeps the draft and an unknown result blocks another save', async () => {
  let commits = 0
  let mode = 'conflict'
  const session = createEditorSession({
    acquireLease: async () => ({ leaseEpoch: 2 }),
    readDocx: async () => ({ file: revision, leaseEpoch: 2, blocks: [{ docxIndex: 0, type: 'paragraph', text: 'Hello', editable: true }] }),
    commitDocx: async () => {
      commits += 1
      if (mode === 'conflict') {
        const error = new Error('conflict')
        error.status = 409
        throw error
      }
      throw new Error('network')
    },
    newKey: () => 'key-123456',
  })
  await session.open('file-1')
  session.updateBlock(0, 'Draft')
  const conflict = await session.save()
  assert.equal(conflict.conflict, true)
  assert.equal(conflict.state.dirty, true)
  assert.equal(conflict.state.blocks[0].text, 'Draft')
  assert.equal(conflict.state.baseRevision, revision.revision)
  mode = 'network'
  const lost = await session.save()
  assert.equal(lost.unknown, true)
  const blocked = await session.save()
  assert.equal(blocked.unknown, true)
  assert.equal(commits, 2)
})

test('a failed lease renewal keeps the draft and does not commit', async () => {
  let commits = 0
  let renewed = 0
  const session = createEditorSession({
    acquireLease: async () => ({ leaseEpoch: 2 }),
    renewLease: async (_id, epoch) => {
      renewed += 1
      assert.equal(epoch, 2)
      const error = new Error('lease')
      error.status = 409
      throw error
    },
    readDocx: async () => ({ file: revision, leaseEpoch: 2, blocks: [{ docxIndex: 0, type: 'paragraph', text: 'Hello', editable: true }] }),
    commitDocx: async () => { commits += 1; return nextRevision },
    newKey: () => 'key-123456',
  })
  await session.open('file-1')
  session.updateBlock(0, 'Still here')
  const saved = await session.save()
  assert.equal(saved.conflict, true)
  assert.equal(saved.state.dirty, true)
  assert.equal(saved.state.blocks[0].text, 'Still here')
  assert.equal(renewed, 1)
  assert.equal(commits, 0)
})
