import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { preloadMethodNames, rendererMethodNames, auditWebHost } from './audit-web-host.mjs'

test('extracts typed preload methods without nested handler fields', () => {
  const source = "const api: DesktopApi = {\n  open: () => ipcRenderer.invoke('open'),\n  onSave(handler) {\n    const payload = {\n      secret: true,\n    }\n  },\n}\n"
  assert.deepEqual(preloadMethodNames(source), ['onSave','open'])
})

test('detects normal and optional bridge calls', () => {
  assert.deepEqual(rendererMethodNames('window.desktop.open(); window.desktop?.save?.();', 'desktop'), ['open','save'])
  assert.deepEqual(rendererMethodNames('window.pdfApi.readFile(1)', 'desktop'), [])
})

test('requires bridge identity and reports methods used by renderer', async t => {
  const root = await mkdtemp(join(tmpdir(),'dyoffice-ipc-'))
  t.after(() => rm(root,{recursive:true,force:true}))
  for (const [app, bridge] of Object.entries({docs:'desktop',sheets:'desktopApi',slides:'slidesApi',pdf:'pdfApi'})) {
    const preload=join(root,'apps',app,'src/preload')
    const renderer=join(root,'apps',app,'src/renderer')
    await mkdir(preload,{recursive:true})
    await mkdir(renderer,{recursive:true})
    const apiType=app==='docs'||app==='sheets'?'DesktopApi':app==='slides'?'SlidesApi':'PdfApi'
    const variable=app==='sheets'?'desktopApi':'api'
    await writeFile(join(preload,'index.ts'),'const ' + variable + ': ' + apiType + " = {\n  open: () => 1,\n  save: () => 2,\n}\ncontextBridge.exposeInMainWorld('" + bridge + "', " + variable + ')')
    await writeFile(join(renderer,'App.tsx'),'window.' + bridge + '.open(); window.' + bridge + '.open(); window.' + bridge + '?.missing?.()')
  }
  const report=await auditWebHost(root)
  assert.equal(Object.keys(report).length,4)
  assert.equal(report.docs.declaredCount,2)
  assert.equal(report.docs.methods.find(m=>m.name==='open').calls,2)
  assert.deepEqual(report.docs.unknownRendererMethods,['missing'])
})

test('extracts async and differently formatted API members, not nested object fields', () => {
  const source = `const desktopApi: DesktopApi = {
    async selectWorkbook() { const nested = { fake: 1 }; return nested },
    'saveWorkbook': async () => ({ nested: 1 }),
    onSave(handler) { return () => {} }, open: () => 1,
  }`
  assert.deepEqual(preloadMethodNames(source), ['onSave','open','saveWorkbook','selectWorkbook'])
})

test('ignores comment/string bridge lookalikes and recognizes literal bracket access', () => {
  const source = `// window.desktop.fake()
    const text = "window.desktop.missing()";
    /* window.desktop.never() */
    window.desktop.open(); window['desktop']['save'](); window.desktop?.close?.();`
  assert.deepEqual(rendererMethodNames(source, 'desktop'), ['open','save','close'])
})

test('refuses unresolved spread/computed API entries instead of publishing a partial count', () => {
  assert.throws(() => preloadMethodNames('const api: DesktopApi = { open() {}, ...more }'), /Unsupported.*API member/)
  assert.throws(() => preloadMethodNames('const api: DesktopApi = { [methodName]() {} }'), /Unsupported.*API member/)
})

test('selects the actual exposed bridge rather than a decoy typed object or comment', () => {
  const source = `const decoy: DesktopApi = { wrong() {} };
    const actual: DesktopApi = { async open() {} };
    // contextBridge.exposeInMainWorld('desktop', decoy)
    contextBridge.exposeInMainWorld("desktop", actual);`
  assert.deepEqual(preloadMethodNames(source, 'desktop'), ['open'])
  assert.throws(() => preloadMethodNames(source, 'missing'), /Expected preload bridge missing not found/)
})

test('invalid source fails closed rather than returning partial inventory', () => {
  assert.throws(() => rendererMethodNames('window.desktop.', 'desktop'), /Cannot parse host inventory source/)
})
