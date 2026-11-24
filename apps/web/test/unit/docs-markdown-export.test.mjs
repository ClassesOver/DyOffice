import assert from 'node:assert/strict'
import { resolveObjectURL } from 'node:buffer'
import test from 'node:test'
import JSZip from 'jszip'
import { MARKDOWN_MEDIA_DIR_TOKEN } from '../../../docs/src/shared/ipc.ts'
import { createDocsBridge } from '../../src/editors/docs-bridge.ts'

const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
const imageReference = (name, alt = '') => `![${alt}](${MARKDOWN_MEDIA_DIR_TOKEN}/${name})`

function fixture(t) {
  const downloads = []
  t.mock.method(globalThis, 'fetch')
  const document = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const window = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { origin: 'null' } } })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    createElement(name) {
      assert.equal(name, 'a')
      return { click() { downloads.push({ name: this.download, blob: resolveObjectURL(this.href) }) } }
    },
  } })
  const bridge = createDocsBridge({ getState: () => ({ name: 'Report.docx' }) }, 'file', { language: 'en' }, () => {})
  t.after(() => {
    bridge.dispose()
    for (const [key, value] of [['document', document], ['window', window]]) {
      if (value) Object.defineProperty(globalThis, key, value)
      else delete globalThis[key]
    }
  })
  return { api: bridge.api, downloads }
}

test('Word Web exports plain Markdown directly', async t => {
  const { api, downloads } = fixture(t)
  const markdown = '# Plain\n\n中文\n'
  const result = await api.exportMarkdown('Plain.docx', markdown, [])
  assert.equal(result.ok, true)
  assert.equal(downloads.length, 1)
  assert.equal(downloads[0].name, 'Plain.md')
  assert.equal(await downloads[0].blob.text(), markdown)
  assert.equal(globalThis.fetch.mock.callCount(), 0)
})

test('Word Web bundles data and same-origin blob pictures with matching relative Markdown paths', async t => {
  const embedded = URL.createObjectURL(new Blob([pixel], { type: 'image/png' }))
  t.after(() => URL.revokeObjectURL(embedded))
  const { api, downloads } = fixture(t)
  const markdown = `# Report\n\n${imageReference('image1.png')}\n\n${imageReference('image2.blob', 'A picture')}\n\n${imageReference('image1.png')}\n`
  const result = await api.exportMarkdown('Report (Q1).docx', markdown, [
    { name: 'image1.png', src: `data:image/png;base64,${pixel.toString('base64')}` },
    { name: 'image2.blob', src: embedded },
  ])
  assert.equal(result.ok, true)
  assert.equal(downloads.length, 1)
  assert.equal(downloads[0].name, 'Report (Q1).zip')
  assert.equal(downloads[0].blob.type, 'application/zip')
  const archive = await JSZip.loadAsync(await downloads[0].blob.arrayBuffer())
  const content = await archive.file('Report (Q1).md').async('string')
  assert.equal(content, '# Report\n\n![](Report%20%28Q1%29_files/image1.png)\n\n![A picture](Report%20%28Q1%29_files/image2.png)\n\n![](Report%20%28Q1%29_files/image1.png)\n')
  for (const image of ['image1.png', 'image2.png']) {
    assert.deepEqual(await archive.file(`Report (Q1)_files/${image}`).async('nodebuffer'), pixel)
  }
  assert.deepEqual(globalThis.fetch.mock.calls.map(call => call.arguments[0]), [embedded])
})

test('Word Web skips invalid and remote images without leaking references or fetching a server', async t => {
  const { api, downloads } = fixture(t)
  const markdown = `${imageReference('image1.png', 'Missing')} ${imageReference('image2.png')}\n`
  const result = await api.exportMarkdown('../Report.docx', markdown, [
    { name: 'image1.png', src: 'https://assets.example/image.png' },
    { name: 'image2.png', src: 'blob:https://unrelated.example/7e4aa631-c9fc-42a5-bdde-565fca0a0c8a' },
    { name: '../bad.png', src: `data:image/png;base64,${pixel.toString('base64')}` },
  ])
  assert.equal(result.ok, true)
  assert.equal(result.imagesDropped, 3)
  assert.equal(downloads.length, 1)
  assert.equal(downloads[0].name, '_Report.md')
  assert.equal(await downloads[0].blob.text(), 'Missing \n')
  assert.equal(globalThis.fetch.mock.callCount(), 0)
})

test('Word Web resolves linked images with long escaped alt text and leaves fenced examples intact', async t => {
  const { api, downloads } = fixture(t)
  const alt = 'Long \\] ' + 'a'.repeat(600)
  const image = imageReference('image1.png', alt)
  const linked = `[${image}](https://example.com)`
  const example = `\`\`\`\n${imageReference('image1.png')}\n\`\`\``
  const result = await api.exportMarkdown('Report.docx', `${example}\n\n${linked}\n`, [
    { name: 'image1.png', src: `data:image/png;base64,${pixel.toString('base64')}` },
  ])
  assert.equal(result.imagesDropped, 0)
  const archive = await JSZip.loadAsync(await downloads[0].blob.arrayBuffer())
  assert.equal(await archive.file('Report.md').async('string'),
    `${example}\n\n[![${alt}](Report_files/image1.png)](https://example.com)\n`)
})

test('Word Web rejects oversized and non-image attachments without changing the Markdown text', async t => {
  const wrongType = URL.createObjectURL(new Blob([pixel], { type: 'constructor' }))
  t.after(() => URL.revokeObjectURL(wrongType))
  const { api, downloads } = fixture(t)
  const oversized = 'data:image/png;base64,' + 'A'.repeat(Math.ceil(16 * 1024 * 1024 / 3) * 4 + 4)
  const result = await api.exportMarkdown('Report.docx', `Text\n${imageReference('image1.png')}${imageReference('image2.blob')}\n`, [
    { name: 'image1.png', src: oversized },
    { name: 'image2.blob', src: wrongType },
  ])
  assert.equal(result.imagesDropped, 2)
  assert.equal(downloads[0].name, 'Report.md')
  assert.equal(await downloads[0].blob.text(), 'Text\n\n')
})
