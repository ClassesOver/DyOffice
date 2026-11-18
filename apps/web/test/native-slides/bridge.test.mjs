import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL, fileURLToPath} from 'node:url'
import {build} from 'esbuild'
import {createSlidesMockServer} from './mock-slides-server.mjs'
import {createSessionFileHost} from '../../../../packages/browser-host/src/files.ts'

async function bundleBridge(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dyoffice-slides-bridge-'))
  t.after(() => rm(dir, {recursive: true, force: true}))
  const outfile = join(dir, 'slides-bridge.mjs')
  await build({entryPoints: [fileURLToPath(new URL('../../src/editors/slides-bridge.ts', import.meta.url))], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent'})
  const {createSlidesBridge} = await import(pathToFileURL(outfile).href)
  return createSlidesBridge
}

async function openBridge(createSlidesBridge, server, t, {acquire = true} = {}) {
  const host = createSessionFileHost({fetchImpl: server.fetchImpl})
  t.after(() => host.dispose())
  await host.open(server.file().fileId)
  if (acquire) await host.acquireLease(server.file().fileId)
  const bridge = createSlidesBridge(host, server.file().fileId, {language: 'en', theme: 'light'}, {fetchImpl: server.fetchImpl})
  t.after(() => bridge.dispose())
  return {host, bridge}
}

test('slides bridge opens, edits text, restructures slides and undoes through server ops', {timeout: 30000}, async t => {
  const createSlidesBridge = await bundleBridge(t)
  const server = createSlidesMockServer({slideCount: 3})
  const {bridge} = await openBridge(createSlidesBridge, server, t)

  const opened = await bridge.api.openPptx(1280)
  assert.equal(opened.slides.length, 3)
  assert.equal(opened.size.cx, 12192000)
  assert.equal(opened.path, 'deck.pptx')
  assert.equal(await bridge.api.isDirty(), false)

  const all = await bridge.api.getRenderSlides()
  assert.equal(all.length, 3)
  assert.equal(all[0].partPath, 'ppt/slides/slide1.xml')

  const edited = await bridge.api.editText({slideIndex: 0, sourceId: 'e1-title', paragraphs: [{runs: [{text: 'Web edited', bold: true}]}]})
  assert.equal(edited.nodes.find(node => node.sourceId === 'e1-title').text, 'Web edited')
  assert.equal(await bridge.api.isDirty(), true)
  assert.deepEqual(server.appliedOps()[0], {op: 'setText', target: {slide: 0, el: 'e1-title'}, paragraphs: [{runs: [{text: 'Web edited', bold: true}]}]})

  const added = await bridge.api.addSlide({sourceIndex: 0, fitWidthPx: 1280})
  assert.equal(added.index, 1)
  assert.equal(added.order.length, 4)
  assert.deepEqual(added.sections, [])

  const inserted = await bridge.api.addElement({slideIndex: 2, kind: 'textbox', text: 'New box', xPx: 320, yPx: 180, wPx: 320, hPx: 90, fitWidthPx: 1280})
  assert.equal(typeof inserted.sourceId, 'string')
  assert.equal(inserted.slide.nodes.some(node => node.sourceId === inserted.sourceId), true)
  const addOp = server.appliedOps().at(-1)
  assert.equal(addOp.op, 'addElement')
  assert.deepEqual(addOp.target, {slide: 2})
  // fitWidthPx viewport maps to the full slide width (12192000 EMU): px -> EMU conversion
  assert.equal(addOp.offset.x, 320 * 12192000 / 1280)
  assert.equal(addOp.offset.cx, 320 * 12192000 / 1280)

  const moved = await bridge.api.moveSlide({fromIndex: 0, toIndex: 2})
  // [s1,s4,s2,s3] -> move s1 to index 2 -> [s4,s2,s1,s3]
  assert.deepEqual(moved.order, ['ppt/slides/slide4.xml', 'ppt/slides/slide2.xml', 'ppt/slides/slide1.xml', 'ppt/slides/slide3.xml'])
  assert.deepEqual(moved.sections, [])

  const deleted = await bridge.api.deleteSlide(0)
  assert.equal(deleted.order.length, 3)

  const undone = await bridge.api.undo()
  assert.equal(undone.length, 4)
  assert.equal(await bridge.api.isDirty(), true)
  const redone = await bridge.api.redo()
  assert.equal(redone.length, 3)
})

test('slides bridge save commits through host.saveSlides and keeps the session generation', {timeout: 30000}, async t => {
  const createSlidesBridge = await bundleBridge(t)
  const server = createSlidesMockServer({slideCount: 2})
  const {host, bridge} = await openBridge(createSlidesBridge, server, t)

  await bridge.api.openPptx(1280)
  await bridge.api.editText({slideIndex: 1, sourceId: 'e2-title', paragraphs: [{runs: [{text: 'kept'}]}]})
  const saved = await bridge.api.save()
  assert.equal(saved.ok, true)
  assert.equal(server.preparations(), 1)
  const head = server.file()
  assert.equal(saved.path, 'deck.pptx')
  assert.equal(host.getState(server.file().fileId).revision.revision, head.revision)
  assert.equal(await bridge.api.isDirty(), false)
  // Session continuity: no re-open round trip, generation preserved for later ops.
  assert.equal(server.sessionState().generation, 1)
  const after = await bridge.api.editText({slideIndex: 1, sourceId: 'e2-title', paragraphs: [{runs: [{text: 'after save'}]}]})
  assert.equal(after.nodes.find(node => node.sourceId === 'e2-title').text, 'after save')
})

test('a lost commit receipt parks the renderer save; late edits carry and confirm replays nothing', {timeout: 30000}, async t => {
  const createSlidesBridge = await bundleBridge(t)
  const server = createSlidesMockServer({slideCount: 2})
  let dropped = false
  const guardedFetch = async (path, init = {}) => {
    const response = await server.fetchImpl(path, init)
    if (!dropped && String(path).endsWith('/commits')) {
      dropped = true
      await response.arrayBuffer()
      throw new TypeError('lost commit response')
    }
    return response
  }
  const host = createSessionFileHost({fetchImpl: guardedFetch})
  t.after(() => host.dispose())
  await host.open(server.file().fileId)
  await host.acquireLease(server.file().fileId)
  const bridge = createSlidesBridge(host, server.file().fileId, {language: 'en', theme: 'light'}, {fetchImpl: guardedFetch})
  t.after(() => bridge.dispose())

  await bridge.api.openPptx(1280)
  await bridge.api.editText({slideIndex: 0, sourceId: 'e1-title', paragraphs: [{runs: [{text: 'pending'}]}]})
  const saving = bridge.api.save()
  let settled = false
  saving.then(() => { settled = true }, () => { settled = true })
  const deadline = Date.now() + 10_000
  while (!bridge.needsConfirmation()) { assert.ok(Date.now() < deadline, 'save must park on an unknown receipt'); await new Promise(resolve => setTimeout(resolve, 20)) }
  assert.equal(settled, false, 'the renderer save promise stays pending across the unknown receipt')
  // Mutations are fenced while the receipt is unconfirmed: the pinned revision
  // may be dead once the staged commit landed, so nothing is silently lost.
  const opsBefore = server.appliedOps().length
  assert.equal(await bridge.api.editText({slideIndex: 0, sourceId: 'e1-title', paragraphs: [{runs: [{text: 'late'}]}]}), null)
  assert.equal(await bridge.api.undo(), null)
  assert.equal(server.appliedOps().length, opsBefore, 'fenced mutations never reach the server')
  await bridge.confirmSave()
  const saved = await saving
  assert.equal(saved.ok, true)
  assert.equal(server.preparations(), 1, 'confirmation must reconcile the receipt, never re-export')
  assert.equal(host.getState(server.file().fileId).status, 'idle')
  // After confirmation the session adopted the committed head; edits flow again
  // and the next save exports them.
  const late = await bridge.api.editText({slideIndex: 0, sourceId: 'e1-title', paragraphs: [{runs: [{text: 'late'}]}]})
  assert.equal(late.nodes.find(node => node.sourceId === 'e1-title').text, 'late')
  assert.equal(await bridge.api.isDirty(), true)
  const second = await bridge.api.save()
  assert.equal(second.ok, true)
  assert.equal(server.preparations(), 2)
  assert.equal(await bridge.api.isDirty(), false)
})

test('slides bridge fences downloads and takeovers on unsaved state', {timeout: 30000}, async t => {
  const createSlidesBridge = await bundleBridge(t)
  const server = createSlidesMockServer({slideCount: 2})
  const {host, bridge} = await openBridge(createSlidesBridge, server, t)
  await bridge.api.openPptx(1280)

  // Clean deck: download returns the confirmed head revision.
  const receipt = await bridge.prepareDownload({saveAndWait: async () => true, isDirty: () => false})
  assert.equal(receipt.revision, server.file().revision)

  // Dirty deck: prepareDownload runs the renderer save cycle first.
  await bridge.api.editText({slideIndex: 0, sourceId: 'e1-title', paragraphs: [{runs: [{text: 'dirty'}]}]})
  let saveRan = false
  const savedReceipt = await bridge.prepareDownload({saveAndWait: async () => { saveRan = true; return (await bridge.api.save()).ok }, isDirty: () => saveRan && false})
  assert.equal(saveRan, true)
  assert.notEqual(savedReceipt.revision, receipt.revision)
  assert.equal(await bridge.api.isDirty(), false)

  // Takeover refuses while edits are unconfirmed, then reloads from the new head.
  await bridge.api.editText({slideIndex: 0, sourceId: 'e1-title', paragraphs: [{runs: [{text: 'kept dirty'}]}]})
  await assert.rejects(() => bridge.takeover({saveAndWait: async () => true, isDirty: () => true}), error => error.code === 'CONFLICT')
  let reopened = null
  bridge.api.onOpened(result => { reopened = result })
  await bridge.prepareDownload({saveAndWait: async () => (await bridge.api.save()).ok, isDirty: () => false})
  server.grantLeaseTo('someone-else')
  let reloads = 0
  await bridge.takeover({saveAndWait: async () => true, isDirty: () => false, reload: async () => { reloads++; return (await bridge.api.openPptx(1280)) !== null }})
  assert.equal(reloads, 1, 'takeover reloads the deck through the editor handle')
  assert.equal(reopened?.slides.length, 2, 'the reopened deck is pushed through onOpened')
  assert.equal(host.getState(server.file().fileId).lease !== null, true)
})

test('desktop-only slides operations reject asynchronously with an explicit unavailable error', {timeout: 30000}, async t => {
  const createSlidesBridge = await bundleBridge(t)
  const server = createSlidesMockServer({slideCount: 1})
  const {bridge} = await openBridge(createSlidesBridge, server, t)
  const desktopOnly = ['printSlides', 'exportPdf', 'exportImages', 'pickExportDir', 'pickExportPdfPath', 'pickExportVideoPath', 'videoFileOpen', 'savePicture', 'listPrinters', 'printerOptions', 'fontInstallLocal', 'fontCatalog', 'fontDownload', 'insertMedia', 'addMediaBytes', 'pickModel3d', 'addModel3d', 'insertImage', 'pickPictureFile',   'openPptxPath', 'newBlank', 'saveAs', 'presenterStart', 'landGeneratedPages', 'localGeneratePage', 'applyEditScript', 'aiStream', 'webSearch', 'masterEnter']
  for (const method of desktopOnly) {
    assert.equal(typeof bridge.api[method], 'function', method)
    let operation
    assert.doesNotThrow(() => { operation = bridge.api[method]({}) }, method)
    await assert.rejects(operation, error => error.message.length > 0 && !/is not a function/.test(error.message), method)
  }
  const localImage = await bridge.api.insertImage(0, 1280).then(() => 'resolved', error => error.message)
  assert.match(localImage, /unavailable|不可用/i)
})

test('slides bridge serves renderer boot reads without desktop facilities', {timeout: 30000}, async t => {
  const createSlidesBridge = await bundleBridge(t)
  const server = createSlidesMockServer({slideCount: 2})
  const {bridge} = await openBridge(createSlidesBridge, server, t)
  assert.equal(await bridge.api.getLanguage(), 'en')
  assert.equal(await bridge.api.getTheme(), 'light')
  assert.deepEqual(await bridge.api.getAutoSaveDefault(), {on: false, updatedAt: 1})
  assert.deepEqual(await bridge.api.clipboardExternal(), {kind: 'none'})
  assert.equal(await bridge.api.clipboardProbe(), false)
  assert.equal(await bridge.api.hasSlideClipboard(), false)
  assert.deepEqual(await bridge.api.getSections(), [])
  assert.equal(await bridge.api.getNotes(0), '')
  assert.equal(await bridge.api.getLayouts(), null)
  assert.deepEqual(await bridge.api.fontMissing(), [])
  assert.deepEqual(await bridge.api.privateFontFaces(), [])
  assert.equal(await bridge.api.privateFontData('x'), null)
  assert.equal(await bridge.api.getSlideSize(), null, 'no slide size before a session is opened')
  assert.equal((await bridge.api.consumePendingOpen(1280)).slides.length, 2)
  // consumePendingOpen is memoized: the renderer's StrictMode double boot and later
  // fallbacks see the same deck instead of falling back to a blank presentation.
  assert.equal((await bridge.api.consumePendingOpen(1280)).slides.length, 2)
  assert.equal(await bridge.api.consumeHeadlessExport(), null)
  assert.deepEqual(await bridge.api.getShowTiming(0), {advanceMs: null, narrationIds: []})
  assert.equal(await bridge.api.getTransition(0), 'none')
  assert.equal(await bridge.api.setNotes({slideIndex: 0, text: 'note'}), true)
  assert.equal(await bridge.api.getNotes(0), 'note')
  const opened = await bridge.api.openPptx(1280)
  assert.deepEqual(await bridge.api.getSlideSize(), {cx: 12192000, cy: 6858000})
  assert.equal(await bridge.api.getTransition(0), 'none')
  const notesOp = server.appliedOps().at(-1)
  assert.equal(notesOp.op, 'setNotes')
})

test('slides bridge stops mutations once the lease is lost', {timeout: 30000}, async t => {
  const createSlidesBridge = await bundleBridge(t)
  const server = createSlidesMockServer({slideCount: 2})
  const {host, bridge} = await openBridge(createSlidesBridge, server, t)
  await bridge.api.openPptx(1280)
  // Another editor takes the document; the local host gives up its lease.
  server.grantLeaseTo('someone-else')
  await host.releaseLease(server.file().fileId).catch(() => {})
  const edits = server.appliedOps().length
  assert.equal(await bridge.api.editText({slideIndex: 0, sourceId: 'e1-title', paragraphs: [{runs: [{text: 'nope'}]}]}), null)
  assert.equal(await bridge.api.addSlide({sourceIndex: 0, fitWidthPx: 1280}), null)
  assert.equal(await bridge.api.deleteSlide(0), null)
  assert.equal(await bridge.api.moveSlide({fromIndex: 0, toIndex: 1}), null)
  assert.equal(await bridge.api.undo(), null)
  const saved = await bridge.api.save()
  assert.equal(saved.ok, false)
  assert.equal(server.appliedOps().length, edits, 'unfenced mutations must never reach the server')
})

test('download refuses a bridge-dirty deck before React dirty state catches up', async t => {
  const createSlidesBridge = await bundleBridge(t)
  const server = createSlidesMockServer({slideCount: 1})
  const {bridge} = await openBridge(createSlidesBridge, server, t)
  await bridge.api.openPptx(1280)
  await bridge.api.editText({slideIndex: 0, sourceId: 'e1-title', paragraphs: [{runs: [{text: 'not yet saved'}]}]})
  assert.equal(bridge.isDirty(), true)
  // The renderer has not processed its asynchronous isDirty() notification.
  await assert.rejects(bridge.prepareDownload({saveAndWait: async () => true, isDirty: () => false}), {code: 'CONFLICT'})
  assert.equal(server.preparations(), 0)
  assert.equal(bridge.isDirty(), true)
  const receipt = await bridge.prepareDownload({saveAndWait: async () => (await bridge.api.save()).ok, isDirty: () => false})
  assert.equal(receipt.revision, server.file().revision)
  assert.equal(bridge.isDirty(), false)
})

test('takeover refuses bridge-dirty edits even before renderer dirty notification', async t => {
  const createSlidesBridge = await bundleBridge(t)
  const server = createSlidesMockServer({slideCount: 1})
  const {bridge} = await openBridge(createSlidesBridge, server, t)
  await bridge.api.openPptx(1280)
  await bridge.api.editText({slideIndex: 0, sourceId: 'e1-title', paragraphs: [{runs: [{text: 'keep my unsaved edit'}]}]})
  let reloads = 0
  await assert.rejects(bridge.takeover({isDirty: () => false, reload: async () => {reloads++; return true}}), {code: 'CONFLICT'})
  assert.equal(reloads, 0)
  assert.equal(bridge.isDirty(), true)
})

test('download fences a server edit arriving after save acknowledgement but before renderer refresh', async t => {
  const createSlidesBridge = await bundleBridge(t)
  const server = createSlidesMockServer({slideCount: 1})
  const {bridge} = await openBridge(createSlidesBridge, server, t)
  await bridge.api.openPptx(1280)
  await bridge.api.editText({slideIndex: 0, sourceId: 'e1-title', paragraphs: [{runs: [{text: 'first edit'}]}]})
  await assert.rejects(bridge.prepareDownload({
    isDirty: () => false,
    async saveAndWait() {
      assert.equal((await bridge.api.save()).ok, true)
      await bridge.api.editText({slideIndex: 0, sourceId: 'e1-title', paragraphs: [{runs: [{text: 'late edit'}]}]})
      return true
    },
  }), {code: 'CONFLICT'})
  assert.equal(server.preparations(), 1)
  assert.equal(bridge.isDirty(), true)
})
