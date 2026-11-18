import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { preloadBridges, analyzeRenderer, auditWebHost, inventoryRows, lifecycleOf } from './audit-web-host.mjs'

const names = (bridge) => bridge.members.map((m) => m.name).sort()

test('parses every member form of a typed preload bridge, including async methods', () => {
  const source = `
const api: DesktopApi = {
  open: () => ipcRenderer.invoke('file:open'),
  async save(bytes) {
    const payload = { secret: true }
    return ipcRenderer.invoke(IPC_CHANNELS.save, bytes, payload)
  },
  onSaved(handler) {
    const l = () => handler()
    ipcRenderer.on('file:saved', l)
    return () => ipcRenderer.removeListener('file:saved', l)
  },
  notify: (n) => ipcRenderer.send('file:dirty', n),
  pathOf: (f) => webUtils.getPathForFile(f),
}
contextBridge.exposeInMainWorld('desktop', api)
contextBridge.exposeInMainWorld('spell', { check: (w) => webFrame.isWordMisspelled(w) })
if (process.env.X === '1') contextBridge.exposeInMainWorld('__debug', true)
installDropOpenBridge()
`
  const { bridges, sideEffects } = preloadBridges(source)
  assert.deepEqual(bridges.map((b) => b.name), ['desktop', 'spell', '__debug'])
  const desktop = bridges[0]
  assert.deepEqual(names(desktop), ['notify', 'onSaved', 'open', 'pathOf', 'save'])
  const by = Object.fromEntries(desktop.members.map((m) => [m.name, m]))
  assert.equal(by.open.lifecycle, 'request')
  assert.deepEqual(by.open.ipc, [{ op: 'invoke', channel: 'file:open' }])
  assert.deepEqual(by.save.ipc, [{ op: 'invoke', channel: '$IPC_CHANNELS.save' }], 'constant channels keep their source text')
  assert.equal(by.onSaved.lifecycle, 'subscription')
  assert.equal(by.notify.lifecycle, 'notify')
  assert.equal(by.pathOf.lifecycle, 'local')
  assert.deepEqual(by.pathOf.ipc, [{ op: 'webUtils.getPathForFile', channel: null }])
  assert.deepEqual(names(bridges[1]), ['check'])
  assert.equal(bridges[2].shape, 'value')
  assert.equal(bridges[2].conditional, true)
  assert.deepEqual(sideEffects, ['installDropOpenBridge'])
})

test('follows spreads of local objects and reports unresolvable members', () => {
  const { bridges } = preloadBridges(`
const shared = { a: () => ipcRenderer.invoke('a') }
const api = { ...shared, ...imported, [dynamic]: 1, b: () => 1 }
contextBridge.exposeInMainWorld('x', api)
`)
  assert.deepEqual(names(bridges[0]), ['a', 'b'])
  assert.deepEqual(bridges[0].unresolved, ['...imported', '[dynamic]: 1'])
})

test('rejects a non-literal bridge name', () => {
  assert.throws(() => preloadBridges('contextBridge.exposeInMainWorld(name, {})'), /not a string literal/)
})

test('lifecycle prefers subscription, then request, then notify', () => {
  assert.equal(lifecycleOf([{ op: 'invoke' }, { op: 'on' }]), 'subscription')
  assert.equal(lifecycleOf([{ op: 'send' }, { op: 'sendSync' }]), 'request')
  assert.equal(lifecycleOf([]), 'local')
})

async function tree(t, files) {
  const base = await mkdtemp(join(tmpdir(), 'dyoffice-ipc-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(base, path, '..'), { recursive: true })
    await writeFile(join(base, path), text)
  }
  return base
}

test('resolves renderer references by symbol, through aliases, parameters and accessors', async (t) => {
  const base = await tree(t, {
    'r/a.tsx': `
import { readBytes } from './helpers'
export function A() {
  window.desktop.open()
  window.desktop?.save?.()
  const d = window.desktop
  d.close()
  const { print, export: exp } = window.desktop
  readBytes(window.desktop, 'x')
  useEffect(() => {}, [d])
  if (!window.desktop) return null
  return typeof window.desktop.later === 'function'
}
export function B(api: { onCommandExecuted(f: unknown): void }) {
  api.onCommandExecuted(() => {})
}
function C() {
  const api = window.other
  api.unrelated()
}
const project = () => (window as unknown as { desktop?: unknown }).desktop ?? {}
function D() { project().resolveChat(); register(window.desktop); const copy = [window.desktop] }
`,
    'r/helpers.ts': `export async function readBytes(api, path) { return api.readFile(path) }`,
  })
  const { calls, opaque } = analyzeRenderer([join(base, 'r/a.tsx')], ['desktop'], base)
  const methods = calls.map((c) => c.method).sort()
  assert.deepEqual(methods, ['close', 'export', 'later', 'open', 'print', 'readFile', 'resolveChat', 'save'])
  assert.ok(calls.find((c) => c.method === 'readFile').file.endsWith('helpers.ts'), 'traced into the helper module')
  assert.ok(!methods.includes('onCommandExecuted'), 'an unrelated variable named like an alias is not the bridge')
  assert.deepEqual(opaque.map((o) => o.text).sort(), ['[window.desktop]', 'register(window.desktop)'])
})

test('treats && guards as presence checks and resolves bracket access to a bridge', async (t) => {
  const base = await tree(t, {
    'r/a.ts': `
export function A() {
  if (window.desktop && window.desktop.open) window.desktop.open()
  const ok = window.desktop && window.desktop.save()
  window['desktop'].close()
  const b = globalThis['desktop']
  b.print()
  const fn = () => { if (ok) return window.desktop; return null }
}
`,
  })
  const { calls, opaque } = analyzeRenderer([join(base, 'r/a.ts')], ['desktop'], base)
  assert.deepEqual(calls.map((c) => c.method).sort(), ['close', 'open', 'open', 'print', 'save'])
  assert.deepEqual(opaque.map((o) => o.text), ['return window.desktop;'], 'a multi-statement accessor stays opaque')
})

test('audits four apps, joins renderer calls and reports unmatched members', async (t) => {
  const files = {}
  const apps = { docs: 'desktop', sheets: 'desktopApi', slides: 'slidesApi', pdf: 'pdfApi' }
  for (const [app, bridge] of Object.entries(apps)) {
    files[`apps/${app}/src/preload/index.ts`] = `const api = {\n  async open() { return ipcRenderer.invoke('${app}:open') },\n  save: () => 2,\n}\ncontextBridge.exposeInMainWorld('${bridge}', api)\ncontextBridge.exposeInMainWorld('projectApi', { listChats: () => ipcRenderer.invoke('project:listChats') })\n`
    files[`apps/${app}/src/renderer/App.tsx`] = `window.${bridge}.open(); window.${bridge}.open(); window.${bridge}?.missing?.(); window.projectApi.listChats()`
  }
  const report = await auditWebHost(await tree(t, files))
  assert.deepEqual(Object.keys(report), ['docs', 'sheets', 'slides', 'pdf'])
  assert.equal(report.docs.declaredCount, 3)
  const open = report.docs.bridges[0].members.find((m) => m.name === 'open')
  assert.equal(open.calls, 2)
  assert.deepEqual(open.ipc, [{ op: 'invoke', channel: 'docs:open' }])
  assert.deepEqual(report.docs.unknownRendererMethods, ['desktop.missing'])
  const rows = inventoryRows(report)
  assert.equal(rows.length, 12)
  assert.ok(rows.some((r) => r.id === 'pdf/projectApi.listChats' && r.calls === 1))
})

// Cases contributed with the parallel upstream AST rewrite, expressed against this API.
const exposedMembers = (source, bridge) => names(preloadBridges(source).bridges.find((b) => b.name === bridge))

test('extracts async, quoted and computed-string API members, not nested object fields', () => {
  const source = `const desktopApi: DesktopApi = {
    async selectWorkbook() { const nested = { fake: 1 }; return nested },
    'saveWorkbook': async () => ({ nested: 1 }),
    ['closeWorkbook']: () => 1,
    onSave(handler) { return () => {} }, open: () => 1,
  }
  contextBridge.exposeInMainWorld('desktopApi', desktopApi)`
  assert.deepEqual(exposedMembers(source, 'desktopApi'), ['closeWorkbook', 'onSave', 'open', 'saveWorkbook', 'selectWorkbook'])
})

test('ignores comment/string bridge lookalikes and recognizes literal bracket access', async (t) => {
  const base = await tree(t, { 'r/a.ts': `// window.desktop.fake()
    const text = "window.desktop.missing()";
    /* window.desktop.never() */
    window.desktop.open(); window['desktop']['save'](); window.desktop?.close?.();` })
  const { calls } = analyzeRenderer([join(base, 'r/a.ts')], ['desktop'], base)
  assert.deepEqual(calls.map((c) => c.method), ['open', 'save', 'close'])
})

test('reports unresolved spread/computed API entries instead of a silently partial count', () => {
  const { bridges } = preloadBridges(`const api: DesktopApi = { open() {}, ...more, [methodName]() {} }
contextBridge.exposeInMainWorld('desktop', api)`)
  assert.deepEqual(names(bridges[0]), ['open'])
  assert.equal(bridges[0].unresolved.length, 2)
})

test('selects the actual exposed bridge rather than a decoy typed object or comment', () => {
  const source = `const decoy: DesktopApi = { wrong() {} };
    const actual: DesktopApi = { async open() {} };
    // contextBridge.exposeInMainWorld('desktop', decoy)
    contextBridge.exposeInMainWorld("desktop", actual);`
  assert.deepEqual(preloadBridges(source).bridges.map((b) => b.name), ['desktop'])
  assert.deepEqual(exposedMembers(source, 'desktop'), ['open'])
})

test('invalid source fails closed rather than returning partial inventory', async (t) => {
  assert.throws(() => preloadBridges('const api = { open() {} \ncontextBridge.exposeInMainWorld("x", api'), /Cannot parse host inventory source/)
  const base = await tree(t, { 'r/a.ts': 'window.desktop.' })
  assert.throws(() => analyzeRenderer([join(base, 'r/a.ts')], ['desktop'], base), /Cannot parse host inventory source/)
})


test('inventories explicit optional transport metadata as a local preload member',()=>{
 const {bridges}=preloadBridges(`const api: DesktopApi = {saveEditsInlineMaxBytes: undefined};contextBridge.exposeInMainWorld('desktopApi',api)`)
 assert.deepEqual(names(bridges[0]),['saveEditsInlineMaxBytes'])
 assert.equal(bridges[0].members[0].lifecycle,'local')
 assert.deepEqual(bridges[0].members[0].ipc,[])
 assert.deepEqual(bridges[0].unresolved,[])
})
