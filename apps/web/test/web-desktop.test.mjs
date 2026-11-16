import { test } from 'node:test'
import assert from 'node:assert/strict'

const bytes = new Uint8Array([1, 2, 3, 4])

function host() {
  const saved = []
  return {
    saved,
    desktop: null,
    async options() {
      const { createWebDesktop } = await import('../../../packages/browser-host/src/web-desktop.ts')
      return createWebDesktop({
        fileId: 'file-1',
        fileName: 'notes.docx',
        async readBytes() { return bytes },
        async saveBytes(_id, data) {
          saved.push(new Uint8Array(data))
          return { revision: 'rev_b' }
        },
        print() { this.printed = (this.printed || 0) + 1 },
        async writeClipboardText(text) { this.clipboard = text },
        async readClipboardText() { return this.clipboard || '' },
        fonts: { 'Missing Font': ['Noto Serif'] },
      })
    },
  }
}

test('web desktop opens and saves through the host and rejects desktop-only calls', async () => {
  const box = host()
  const desktop = await box.options()
  const opened = await desktop.openDocx()
  assert.equal(opened.path, 'file-1')
  assert.match(opened.dataUrl, /^data:application\/vnd.openxmlformats/)
  const saved = await desktop.saveDocx('file-1', bytes.buffer)
  assert.equal(saved.ok, true)
  assert.equal(saved.revision, 'rev_b')
  assert.deepEqual(box.saved[0], bytes)
  await assert.rejects(async () => desktop.runCli(['ls']), (error) => error.code === 'UNSUPPORTED')
  await assert.rejects(async () => desktop.listPrinters(), (error) => error.code === 'UNSUPPORTED')
  await assert.rejects(async () => desktop.exportPdf('a', 1, 1), (error) => error.code === 'UNSUPPORTED')
})

test('font substitution is explicit, print has no fake path, and clipboard text does not accept custom formats', async () => {
  const box = host()
  const state = { printed: 0, clipboard: '' }
  const { createWebDesktop } = await import('../../../packages/browser-host/src/web-desktop.ts')
  const desktop = createWebDesktop({
    fileId: 'file-1',
    fileName: 'notes.docx',
    async readBytes() { return bytes },
    async saveBytes() { return { revision: 'rev_b' } },
    print() { state.printed += 1 },
    async writeClipboardText(text) { state.clipboard = text },
    async readClipboardText() { return state.clipboard },
    fonts: { Calibri: ['Carlito'] },
  })
  assert.deepEqual(await desktop.fontAliases(['Calibri', 'Unknown Face']), {
    Calibri: ['Carlito'],
    'Unknown Face': [],
  })
  assert.equal(await desktop.fontMetrics('Unknown Face'), null)
  const printed = await desktop.print()
  assert.deepEqual(printed, { ok: true })
  assert.equal(state.printed, 1)
  assert.equal('path' in printed, false)
  await desktop.writeClipboardText('Hello')
  assert.equal(await desktop.readClipboardText(), 'Hello')
  await assert.rejects(desktop.copyImageToClipboard('data:image/png;base64,aaaa'), (error) => error.code === 'UNSUPPORTED')
})
