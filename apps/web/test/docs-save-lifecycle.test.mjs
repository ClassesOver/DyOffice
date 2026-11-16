import { test } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { mountDocsEditor } from '../../../packages/browser-host/src/files.ts'

function projection(revision, text) {
  return {
    file: { fileId: 'file-1', revision, sha256: 'ab'.repeat(32), size: 4 },
    leaseEpoch: 2,
    blocks: [{ docxIndex: 0, type: 'paragraph', text, editable: true }],
  }
}

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

function container(t) {
  const dom = new JSDOM('<!DOCTYPE html><div id="editor"></div>')
  t.after(() => dom.window.close())
  return dom.window.document.getElementById('editor')
}

test('a successful commit advances the baseline even when projection refresh fails', async (t) => {
  let current = projection('rev_a', 'Hello')
  let reads = 0
  const refreshing = deferred()
  const release = deferred()
  const bases = []
  const host = {
    acquireLease: async () => ({ leaseEpoch: 2 }),
    readDocx: async () => {
      if (++reads === 2) {
        refreshing.resolve()
        await release.promise
        throw new Error('Temporary read failure')
      }
      return current
    },
    commitDocx: async (_fileId, input) => {
      bases.push(input.baseRevision)
      if (input.baseRevision !== current.file.revision) {
        throw Object.assign(new Error('Stale revision'), { code: 'CONFLICT' })
      }
      current = projection(bases.length === 1 ? 'rev_b' : 'rev_c', input.blocks[0].text)
      return current.file
    },
  }
  const editor = await mountDocsEditor(host, container(t), 'file-1')
  t.after(() => editor.destroy())
  editor.updateText(0, 'Hello there')
  const saving = editor.save()
  await refreshing.promise
  editor.updateText(0, 'Hello there!')
  release.resolve()
  assert.equal((await saving).ok, false)
  assert.equal(editor.getState().revision, 'rev_b')
  assert.equal(editor.getState().blocks[0].text, 'Hello there!')
  assert.equal(editor.getState().dirty, true)
  assert.equal((await editor.save()).ok, true)
  assert.deepEqual(bases, ['rev_a', 'rev_b'])
  assert.equal(current.blocks[0].text, 'Hello there!')
  assert.equal(editor.getState().dirty, false)
})

for (const phase of ['commit', 'refresh']) {
  test(`destroy during ${phase} prevents the old editor from replacing a new mount`, async (t) => {
    const entered = deferred()
    const release = deferred()
    let reads = 0
    const host = {
      acquireLease: async () => ({ leaseEpoch: 2 }),
      readDocx: async () => {
        if (++reads === 2 && phase === 'refresh') {
          entered.resolve()
          await release.promise
        }
        return projection(reads === 1 ? 'rev_a' : 'rev_b', reads === 1 ? 'Hello' : 'Saved')
      },
      commitDocx: async () => {
        if (phase === 'commit') {
          entered.resolve()
          await release.promise
        }
        return projection('rev_b', 'Saved').file
      },
    }
    const element = container(t)
    const editor = await mountDocsEditor(host, element, 'file-1')
    t.after(() => editor.destroy())
    editor.updateText(0, 'Saved')
    const saving = editor.save()
    await entered.promise
    editor.destroy()
    const replacement = element.ownerDocument.createElement('p')
    replacement.textContent = 'Another document'
    element.append(replacement)
    release.resolve()
    await saving
    assert.equal(element.firstChild, replacement)
    assert.equal(element.childNodes.length, 1)
  })
}

test('destroy during lease renewal prevents a new commit from starting', async (t) => {
  const entered = deferred()
  const release = deferred()
  let commits = 0
  const host = {
    acquireLease: async () => ({ leaseEpoch: 2 }),
    readDocx: async () => projection('rev_a', 'Hello'),
    renewLease: async () => {
      entered.resolve()
      await release.promise
      return { leaseEpoch: 2 }
    },
    commitDocx: async () => { commits += 1; return projection('rev_b', 'Saved').file },
  }
  const editor = await mountDocsEditor(host, container(t), 'file-1', { renewEveryMs: 0 })
  t.after(() => editor.destroy())
  editor.updateText(0, 'Saved')
  const saving = editor.save()
  await entered.promise
  editor.destroy()
  release.resolve()
  assert.equal((await saving).ok, false)
  assert.equal(commits, 0)
})
