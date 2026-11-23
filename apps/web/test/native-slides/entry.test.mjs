import {test} from 'node:test'
import assert from 'node:assert/strict'
import {writeFile, mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL, fileURLToPath} from 'node:url'
import {build} from 'esbuild'
import {JSDOM} from 'jsdom'
import {createSlidesMockServer} from './mock-slides-server.mjs'
import {createSessionFileHost} from '../../../../packages/browser-host/src/files.ts'

// Mirrors the real renderer seam (Apps props added for T10): the stub boots through
// consumePendingOpen, reports the editor handle via host.onEditorReady and reacts to
// onOpened pushes exactly like apps/slides/src/renderer/App.tsx does.
const STUB_APP = `
import {useEffect, useState} from 'react'
export function App({host} = {}) {
  const [count, setCount] = useState(null)
  useEffect(() => {
    const api = window.slidesApi
    window.__slidesEntryProbe = {api, openedResults: [], saves: 0, readOnly: host?.readOnly === true, assistantMediaCapabilities: host?.assistant?.mediaCapabilities}
    api.onOpened(result => { window.__slidesEntryProbe.openedResults.push(result) })
    let handle
    handle = {
      async saveAndWait() {
        window.__slidesEntryProbe.saves++
        return (await api.save()).ok
      },
      isDirty() { return !!window.__slidesEntryProbe.dirty },
      canContinueAssistant() { return !window.__slidesEntryProbe.dirty && !window.__slidesEntryProbe.editing },
      async reload() {
        const r = await api.openPptx(1280)
        if (!r) return false
        setCount(r.slides.length)
        return true
      },
    }
    host?.onEditorReady?.(handle)
    void api.consumePendingOpen(1280).then(result => {
      if (!result) { host?.onOpenFailed?.(); return }
      host?.onDeckOpened?.()
      setCount(result.slides.length)
    }).catch(() => { host?.onOpenFailed?.() })
  }, [])
  if (window.__slidesEntryProbe) {
    if(window.__slidesEntryProbe.markReadOnlyDirty && host?.readOnly && !window.__slidesEntryProbe.readOnly)window.__slidesEntryProbe.dirty=true
    window.__slidesEntryProbe.readOnly = host?.readOnly === true
    window.__slidesEntryProbe.assistantMediaCapabilities = host?.assistant?.mediaCapabilities
  }
  return <div className="app-shell"><span data-slides-app="mounted">{count === null ? 'opening' : count + ' slides'}</span>{host?.saveDownload}</div>
}
`

const STUB_NOOP = 'export function installCanvasKerning(): void {}\n'
const STUB_ASSISTANT = `
export async function createEditorAssistant(options) {
  window.__slidesContinuationRevision=options?.continuationRevision
  return {
    available: true,
    workspace: {conversation: children => children},
    documents:{register(target){window.__analysisTarget=target;return ()=>{window.__analysisTarget=null}}},
    mediaCapabilities: {imageGeneration: true, mediaAnalysis: true},
    api: {
      pickAttachments: async () => ({accepted: [{path: 'web-attachment:test'}], rejected: []}),
      getPathForFile: () => 'web-attachment:test',
      addAttachmentPaths: async paths => ({accepted: paths.map(path => ({path})), rejected: []}),
      addPastedImage: async () => ({accepted: [], rejected: []}),
      readAttachment: async () => ({ok: true, text: 'attachment text'}),
      readAttachmentImage: async () => ({ok: true, base64: 'aGVsbG8=', mime: 'image/png'}),
      skillsList: async () => [{name: 'weekly-report', description: 'Create weekly Office reports', relevance: {relevant: true}}],
      skillText: async name => name === 'weekly-report' ? '# Weekly report instructions' : Promise.reject(new Error('Skill unavailable')),
    },
    dispose() {},
  }
}
`

/** Bundles slides-entry.tsx with the heavy slides renderer App replaced by a probe stub. */
async function bundleEntry(t) {
  // The stub must live inside the repo tree so bare 'react' resolves through
  // apps/web/node_modules; outputs go to a per-test temp dir.
  const dir = await mkdtemp(join(tmpdir(), 'dyoffice-slides-entry-'))
  t.after(() => rm(dir, {recursive: true, force: true}))
  const here = fileURLToPath(new URL('.', import.meta.url))
  const stub = join(here, '.entry-stub-app.jsx')
  const noop = join(here, '.entry-stub-kerning.ts')
  const assistantStub = join(here, '.entry-stub-assistant.ts')
  await writeFile(stub, STUB_APP)
  await writeFile(noop, STUB_NOOP)
  await writeFile(assistantStub, STUB_ASSISTANT)
  t.after(() => rm(stub, {force: true}).catch(() => {}).then(() => rm(noop, {force: true}).catch(() => {})).then(() => rm(assistantStub, {force: true}).catch(() => {})))
  const redirects = new Map([
    ['../../../slides/src/renderer/App', stub],
    ['../../../slides/src/renderer/canvas-kerning', noop],
    ['./assistant', assistantStub],
  ])
  const redirect = {
    name: 'slides-entry-stub',
    setup(builder) {
      builder.onResolve({filter: /.*/}, args => redirects.has(args.path) ? {path: redirects.get(args.path)} : null)
    },
  }
  const outfile = join(dir, 'slides-entry.mjs')
  await build({
    entryPoints: [fileURLToPath(new URL('../../src/editors/slides-entry.tsx', import.meta.url))],
    bundle: true, platform: 'browser', format: 'esm', outfile, logLevel: 'silent',
    loader: {'.css': 'empty', '.png': 'dataurl', '.svg': 'dataurl', '.gif': 'dataurl', '.jpg': 'dataurl', '.webp': 'dataurl', '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl'},
    plugins: [redirect],
    jsx: 'automatic',
  })
  return import(pathToFileURL(outfile).href)
}

test('slides entry installs the Web attachment API for GenOffice AI tools and restores it on close', {timeout: 60000}, async t => {
  const server = createSlidesMockServer({slideCount: 1})
  const dom = installDom(t)
  globalThis.fetch = server.fetchImpl
  const host = createSessionFileHost({fetchImpl: server.fetchImpl})
  t.after(() => host.dispose())
  const {mountSlidesEditor} = await bundleEntry(t)
  const mounted = await mountSlidesEditor(host, dom.window.document.getElementById('mount'), server.file().fileId)
  await until(() => typeof dom.window.desktop?.pickAttachments === 'function', 'Web attachment API')
  assert.deepEqual(await dom.window.desktop.pickAttachments(), {accepted: [{path: 'web-attachment:test'}], rejected: []})
  assert.deepEqual(await dom.window.desktop.readAttachmentImage('web-attachment:test'), {ok: true, base64: 'aGVsbG8=', mime: 'image/png'})
  await until(() => dom.window.__slidesEntryProbe?.assistantMediaCapabilities, 'SaaS media capabilities')
  assert.deepEqual(dom.window.__slidesEntryProbe.assistantMediaCapabilities, {imageGeneration: true, mediaAnalysis: true})
  assert.deepEqual(await dom.window.slidesApi.skillsList(), [{name: 'weekly-report', description: 'Create weekly Office reports', relevant: true}])
  assert.equal(await dom.window.slidesApi.skillText('weekly-report'), '# Weekly report instructions')
  assert.equal(dom.window.__analysisTarget.format,'pptx')
  assert.equal(dom.window.__analysisTarget.fileId,server.file().fileId)
  mounted.unload()
  assert.equal(dom.window.__analysisTarget,null)
  assert.equal(dom.window.desktop, undefined)
})

function installDom(t) {
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="mount"></div><div id="root"></div></body></html>', {pretendToBeVisual: true, url: 'https://slides.example/native-pptx/?fileId='})
  // Assign the DOM globals the entry touches as plain values (never accessor
  // descriptors: jsdom getters close over their own window and recurse).
  const previous = new Map()
  const assign = (key, value) => {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, {value, configurable: true, writable: true})
  }
  assign('window', dom.window)
  assign('location', dom.window.location)
  assign('WebSocket', undefined)
  for (const key of ['document', 'navigator', 'HTMLElement', 'HTMLAnchorElement', 'HTMLInputElement', 'Event', 'KeyboardEvent', 'MouseEvent', 'CustomEvent', 'MutationObserver']) assign(key, dom.window[key])
  assign('getComputedStyle', dom.window.getComputedStyle.bind(dom.window))
  // Restore only globals Node owned before (navigator); the DOM globals stay
  // assigned so react-dom can finish unmounting the previous test's root, and
  // the next test simply overwrites them.
  t.after(() => {
    for (const [key, descriptor] of previous) {
      if (!descriptor) continue
      try { Object.defineProperty(globalThis, key, descriptor) } catch { /* keep the jsdom value */ }
    }
  })
  return dom
}

const settle = () => new Promise(resolve => setTimeout(resolve, 25))
async function until(condition, label, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    assert.ok(Date.now() < deadline, 'timed out waiting for ' + label)
    await settle()
  }
}

const statusText = container => [...container.querySelectorAll('.document-notification')].map(node=>node.textContent).join(' ')
// The entry's bridge is private; recovery state is observable through document notifications.
const bridgeProbe = () => 'n/a'

test('slides entry mounts the renderer, saves and downloads through the confirmed receipt', {timeout: 60000}, async t => {
  const server = createSlidesMockServer({slideCount: 2})
  const dom = installDom(t)
  const downloads = []
  dom.window.document.addEventListener('click', event => {
    if (event.target instanceof dom.window.HTMLAnchorElement) { downloads.push(event.target.getAttribute('href')); event.preventDefault() }
  }, true)
  globalThis.fetch = server.fetchImpl
  const host = createSessionFileHost({fetchImpl: server.fetchImpl})
  t.after(() => host.dispose())
  const container = dom.window.document.getElementById('mount')
  const {mountSlidesEditor} = await bundleEntry(t)
  const mounted = await mountSlidesEditor(host, container, server.file().fileId)
  t.after(() => mounted.unload())

  await until(() => container.querySelector('[data-slides-app]')?.textContent === '2 slides', 'renderer App boot')
  await until(() => typeof window.__slidesContinuationRevision === 'function', 'assistant authority loaded')
  const cleanRevision=window.__slidesContinuationRevision
  assert.equal(cleanRevision(), server.file().revision)
  window.__slidesEntryProbe.editing=true
  assert.equal(cleanRevision(), undefined, 'a pending editor draft fences recovery')
  window.__slidesEntryProbe.editing=false
  assert.equal(container.querySelector('.dyoffice-slides-state'), null, 'no separate editor status bar')
  const saveButton = () => container.querySelector('.dyoffice-slides-download')
  await until(() => saveButton()?.disabled === false, 'save button enabled')
  assert.equal(downloads.length, 0)

  // Clean deck: download pins the opened, confirmed head without exporting.
  saveButton().click()
  await until(() => downloads.length === 1, 'clean download')
  assert.match(downloads[0], new RegExp('/api/v1/files/' + server.file().fileId + '/content\\?revision=' + server.file().revision))
  assert.equal(server.preparations(), 0, 'a clean deck downloads the existing head without exporting')
  assert.equal(window.__slidesEntryProbe.saves, 1, 'the renderer save cycle ran; the bridge short-circuited the clean export')

  // A dirty deck runs the renderer save cycle first, then downloads the new receipt.
  await globalThis.window.__slidesEntryProbe.api.editText({slideIndex: 0, sourceId: 'e1-title', paragraphs: [{runs: [{text: 'entry edit'}]}]})
  assert.equal(cleanRevision(), undefined, 'unsaved bridge changes fence recovery')
  saveButton().click()
  await until(() => downloads.length === 2, 'saved download')
  assert.notEqual(downloads[1], downloads[0])
  assert.equal(server.preparations(), 1)
  assert.equal(window.__slidesEntryProbe.saves, 2, 'the dirty download ran one renderer save cycle')
  await until(() => saveButton()?.disabled === false, 'download available again')
  assert.equal(cleanRevision(), server.file().revision, 'the confirmed revision is usable after save')
})

test('slides entry surfaces an unknown commit receipt and confirms it without re-exporting', {timeout: 60000}, async t => {
  const server = createSlidesMockServer({slideCount: 1})
  const dom = installDom(t)
  const downloads = []
  dom.window.document.addEventListener('click', event => {
    if (event.target instanceof dom.window.HTMLAnchorElement) { downloads.push(event.target.getAttribute('href')); event.preventDefault() }
  }, true)
  let dropped = false
  globalThis.fetch = async (path, init) => {
    const response = await server.fetchImpl(path, init)
    if (!dropped && String(path).endsWith('/commits')) { dropped = true; await response.arrayBuffer(); throw new TypeError('lost commit reply') }
    return response
  }
  // The host shares the dropping fetch: a lost commit reply is only observable
  // when every caller (host commits and bridge calls) sees the same transport.
  const host = createSessionFileHost({fetchImpl: globalThis.fetch})
  t.after(() => host.dispose())
  const container = dom.window.document.getElementById('mount')
  const {mountSlidesEditor} = await bundleEntry(t)
  const mounted = await mountSlidesEditor(host, container, server.file().fileId)
  t.after(() => mounted.unload())
  await until(() => container.querySelector('[data-slides-app]')?.textContent === '1 slides', 'renderer App boot')

  await globalThis.window.__slidesEntryProbe.api.editText({slideIndex: 0, sourceId: 'e1-title', paragraphs: [{runs: [{text: 'unknown receipt'}]}]})
  container.querySelector('.dyoffice-slides-download').click()
  await new Promise(resolve => setTimeout(resolve, 300))
  const confirm = () => container.querySelector('[data-save-fence-allow="confirm"]')
  await until(() => confirm() !== null, 'confirm save outcome button')
  assert.match(statusText(container), /Save outcome needs confirmation/)
  assert.equal(downloads.length, 0, 'no download while the receipt is unconfirmed')
  confirm().click()
  await until(() => downloads.length === 1, 'confirmed download')
  assert.equal(server.preparations(), 1, 'confirmation reconciles the staged commit without a second export')
  await until(() => !container.querySelector('[data-save-fence-allow="confirm"]'), 'confirmation cleared')
  assert.match(server.file().revision, /^[0-9a-f-]{36}$/)
})

test('slides entry is read only without the lease and takes over editing explicitly', {timeout: 60000}, async t => {
  const server = createSlidesMockServer({slideCount: 2})
  const dom = installDom(t)
  globalThis.fetch = server.fetchImpl
  const host = createSessionFileHost({fetchImpl: server.fetchImpl})
  t.after(() => host.dispose())
  const container = dom.window.document.getElementById('mount')
  const {mountSlidesEditor} = await bundleEntry(t)
  const fileId = server.file().fileId
  // Another editor already holds the document: the entry mounts without a lease.
  server.grantLeaseTo('first-editor')
  const mounted = await mountSlidesEditor(host, container, fileId)
  t.after(() => mounted.unload())
  await until(() => statusText(container).includes('Read only'), 'read-only status')
  assert.equal(container.querySelector('[data-slides-app]') === null, true, 'no parser session may open without a server lease')
  const takeover = () => container.querySelector('.dyoffice-slides-takeover')
  await until(() => takeover() !== null && takeover().disabled === false, 'takeover button')
  const save = () => container.querySelector('.dyoffice-slides-download')
  assert.equal(save(), null, 'no save action without an authorized editor')
  assert.ok(container.querySelector('.document-notification a[href*="content?revision="]'), 'read-only download link to the opened revision')

  server.grantLeaseTo('first-editor')
  takeover().click()
  await until(() => save()?.disabled === false, 'download enabled after takeover')
  assert.equal(statusText(container).includes('Read only'), false)
  assert.equal(window.__slidesEntryProbe.openedResults.length, 0, 'first authorized mount boots once rather than reusing an unowned draft')
  assert.equal(container.querySelector('[data-slides-app]')?.textContent, '2 slides')
  assert.equal(window.__slidesEntryProbe.readOnly, false, 'the renderer left read-only mode')
  assert.equal(host.getState(fileId).lease !== null, true)
})

test('lease loss after mount preserves dirty renderer and blocks takeover and save',async t=>{
 const server=createSlidesMockServer({slideCount:2}),dom=installDom(t)
 globalThis.fetch=server.fetchImpl
 const host=createSessionFileHost({fetchImpl:server.fetchImpl});t.after(()=>host.dispose())
 const container=dom.window.document.getElementById('mount'),{mountSlidesEditor}=await bundleEntry(t),id=server.file().fileId
 const mounted=await mountSlidesEditor(host,container,id);t.after(()=>mounted.unload())
 await until(()=>container.querySelector('[data-slides-app]')?.textContent==='2 slides','authorized initial mount')
 window.__slidesEntryProbe.dirty=true
 const original=container.querySelector('[data-slides-app]')
 server.grantLeaseTo('another-editor')
 await assert.rejects(()=>host.renewLease(id))
 await until(()=>window.__slidesEntryProbe.readOnly,'lease loss read-only')
 assert.equal(container.querySelector('[data-slides-app]')===original,true,'dirty renderer remains mounted')
 assert.equal(container.querySelector('.dyoffice-slides-download').disabled,true)
 assert.equal(container.querySelector('.dyoffice-slides-takeover'),null)
 const recover=container.querySelector('.dyoffice-slides-recover')
 assert.ok(recover&&!recover.disabled)
 let downloaded=''
 const click=dom.window.HTMLAnchorElement.prototype.click
 dom.window.HTMLAnchorElement.prototype.click=function(){downloaded=this.download}
 t.after(()=>{dom.window.HTMLAnchorElement.prototype.click=click})
 recover.click()
 await until(()=>downloaded.endsWith('-draft.pptx'),'draft download after lease loss')
 assert.equal(host.getState(id).lease,null)
 assert.equal(window.__slidesEntryProbe.saves,0)
 assert.equal(window.__slidesEntryProbe.dirty,true)
})

test('tab close refuses dirty discard and releases its lease before clean disposal',async t=>{
 const server=createSlidesMockServer({slideCount:2}),dom=installDom(t)
 globalThis.fetch=server.fetchImpl
 const host=createSessionFileHost({fetchImpl:server.fetchImpl})
 const container=dom.window.document.getElementById('mount'),{mountSlidesEditor}=await bundleEntry(t),id=server.file().fileId
 const mounted=await mountSlidesEditor(host,container,id)
 t.after(()=>{mounted.unload();host.dispose()})
 await until(()=>container.querySelector('[data-slides-app]')?.textContent==='2 slides','mounted')
 window.__slidesEntryProbe.dirty=true
 dom.window.confirm=()=>false
 assert.equal(await mounted.canClose(),false)
 assert.equal(await mounted.dispose(),false)
 assert.ok(container.querySelector('[data-slides-app]'))
 assert.ok(host.getState(id).lease)
 window.__slidesEntryProbe.dirty=false
 assert.equal(await mounted.canClose(),true)
 assert.equal(await mounted.dispose(),true)
 assert.equal(host.getState(id).lease,null)
 assert.equal(container.querySelector('[data-slides-app]'),null)
})
test('failed editor bootstrap remains closable instead of trapping the failed tab',async t=>{
 const dom=installDom(t)
 await bundleEntry(t)
 await until(()=>dom.window.document.getElementById('root')?.textContent.includes('无法')||dom.window.document.getElementById('root')?.textContent.includes('Unable'),'failed bootstrap')
 assert.equal(await dom.window.dyofficeEditorCanClose(),true)
 assert.equal(await dom.window.dyofficeEditorDispose(),true)
})

test('lease release during clean disposal does not push an artificial read-only edit into the renderer',async t=>{
 const server=createSlidesMockServer({slideCount:2}),dom=installDom(t)
 globalThis.fetch=server.fetchImpl
 const host=createSessionFileHost({fetchImpl:server.fetchImpl})
 const release=host.releaseLease
 host.releaseLease=async(...args)=>{await release(...args);await settle()}
 const container=dom.window.document.getElementById('mount'),{mountSlidesEditor}=await bundleEntry(t),id=server.file().fileId
 const mounted=await mountSlidesEditor(host,container,id)
 t.after(()=>{mounted.unload();host.dispose()})
 await until(()=>container.querySelector('[data-slides-app]')?.textContent==='2 slides','mounted')
 window.__slidesEntryProbe.markReadOnlyDirty=true
 assert.equal(await mounted.canClose(),true)
 assert.equal(await mounted.dispose(),true)
 assert.equal(container.querySelector('[data-slides-app]'),null)
})

test('slides readiness is published only after slide content replaces the opening screen', {timeout:60000}, async t => {
  const server=createSlidesMockServer({slideCount:2}),dom=installDom(t)
  globalThis.fetch=server.fetchImpl
  const host=createSessionFileHost({fetchImpl:server.fetchImpl})
  t.after(()=>host.dispose())
  const {mountSlidesEditor}=await bundleEntry(t)
  const container=dom.window.document.getElementById('mount'),readyContent=[]
  const observer=new dom.window.MutationObserver(()=>{
    if(dom.window.document.documentElement.dataset.documentLoading==='ready')readyContent.push(container.querySelector('[data-slides-app]')?.textContent)
  })
  observer.observe(dom.window.document.documentElement,{attributes:true,attributeFilter:['data-document-loading']})
  t.after(()=>observer.disconnect())
  const mounted=await mountSlidesEditor(host,container,server.file().fileId)
  t.after(()=>mounted.unload())
  await until(()=>readyContent.length>0,'committed ready state')
  assert.deepEqual(readyContent,['2 slides'])
})
