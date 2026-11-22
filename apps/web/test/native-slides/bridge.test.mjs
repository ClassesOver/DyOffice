import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL, fileURLToPath} from 'node:url'
import {build} from 'esbuild'
import {PNG} from 'pngjs'
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

async function openBridge(createSlidesBridge, server, t, {acquire = true, mediaApi, skillsApi} = {}) {
  const host = createSessionFileHost({fetchImpl: server.fetchImpl})
  t.after(() => host.dispose())
  await host.open(server.file().fileId)
  if (acquire) await host.acquireLease(server.file().fileId)
  const bridge = createSlidesBridge(host, server.file().fileId, {language: 'en', theme: 'light'}, {fetchImpl: server.fetchImpl, mediaApi, skillsApi})
  t.after(() => bridge.dispose())
  return {host, bridge}
}

test('slides bridge forwards actual AI history checkpoints and adopts confirmed restoration',async t=>{
 const createSlidesBridge=await bundleBridge(t),server=createSlidesMockServer({slideCount:1}),host=createSessionFileHost({fetchImpl:server.fetchImpl})
 t.after(()=>host.dispose());await host.open(server.file().fileId);await host.acquireLease(server.file().fileId)
 const calls=[]
 const bridge=createSlidesBridge(host,server.file().fileId,{language:'en',theme:'light'},{fetchImpl:async(url,init)=>{
  const method=String(url).split('/').at(-1)
  if(['history-batch-begin','history-batch-end','snapshot-restore'].includes(method)){
   const body=JSON.parse(init.body);calls.push({method,body})
   const result=method==='history-batch-begin'?{opened:true}:method==='history-batch-end'?{snapshotId:12,history:{canUndo:true,canRedo:false}}:{generation:2,dirty:false,slides:[{widthPx:960,heightPx:540,scale:1,nodes:[],partPath:'restored'}],history:{canUndo:true,canRedo:false}}
   return new Response(JSON.stringify(result),{headers:{'content-type':'application/json'}})
  }
  return server.fetchImpl(url,init)
 }})
 t.after(()=>bridge.dispose())
 await bridge.api.openPptx(960)
 assert.equal(await bridge.api.beginHistoryBatch(),true)
 await bridge.api.editText({slideIndex:0,sourceId:'e1-title',paragraphs:[{runs:[{text:'Changed'}]}]})
 const histories=[]
 bridge.api.onHistoryChanged(state=>histories.push(state))
 assert.equal(await bridge.api.endHistoryBatch(),12)
 assert.deepEqual(histories.at(-1),{canUndo:true,canRedo:false})
 assert.equal((await bridge.api.aiSnapshotRestore(12))[0].partPath,'restored')
 assert.equal(await bridge.api.isDirty(),false)
 assert.deepEqual(calls.map(({method,body})=>[method,body.generation,body.snapshotId]),[['history-batch-begin',0,undefined],['history-batch-end',1,undefined],['snapshot-restore',1,12]])
 assert.ok(calls.every(({body})=>body.revision===server.file().revision&&body.editorId&&body.leaseEpoch===1))
 await host.releaseLease(server.file().fileId)
 assert.equal(await bridge.api.beginHistoryBatch(),false)
 assert.equal(await bridge.api.aiSnapshotRestore(12),null)
 assert.equal(calls.length,3)
})

test('slides bridge delegates user skill listing and body reads to the shared skills client', {timeout: 30000}, async t => {
  const createSlidesBridge = await bundleBridge(t)
  const server = createSlidesMockServer({slideCount: 1})
  const entry = {name: 'weekly-report', description: 'Create weekly Office reports', relevant: true}
  const {bridge} = await openBridge(createSlidesBridge, server, t, {
    skillsApi: {
      skillsList: async () => [entry],
      skillText: async name => name === entry.name ? '# Weekly report instructions' : Promise.reject(new Error('Skill unavailable')),
    },
  })

  assert.deepEqual(await bridge.api.skillsList(), [entry])
  assert.equal(await bridge.api.skillText(entry.name), '# Weekly report instructions')
  await assert.rejects(bridge.api.skillText('missing'), /Skill unavailable/)
})

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

test('slides bridge persists comments through the PPTX session instead of acknowledging a no-op', {timeout: 30000}, async t => {
  const createSlidesBridge = await bundleBridge(t)
  const server = createSlidesMockServer({slideCount: 1})
  const {bridge} = await openBridge(createSlidesBridge, server, t)
  await bridge.api.openPptx(1280)

  const added = await bridge.api.addComment({slideIndex: 0, text: 'Review this title'})
  assert.deepEqual(server.appliedOps().at(-1), {
    op: 'addComment', target: {slide: 0}, author: 'Web User', text: 'Review this title',
  })
  assert.equal(added[0].text, 'Review this title')
  assert.deepEqual(await bridge.api.getComments(0), added)
  const deleted = await bridge.api.deleteComment({slideIndex: 0, authorId: added[0].authorId, idx: added[0].idx})
  assert.deepEqual(deleted, [])
  assert.equal(await bridge.api.isDirty(), true)
})

test('slides bridge moves a multi-selection as a block through one server transaction', {timeout: 30000}, async t => {
  const createSlidesBridge = await bundleBridge(t)
  const server = createSlidesMockServer({slideCount: 4})
  const {bridge} = await openBridge(createSlidesBridge, server, t)
  await bridge.api.openPptx(1280)

  const result = await bridge.api.moveSlides({slideIndexes: [0, 2], insertAt: 4})

  assert.deepEqual(server.appliedOps(), [
    {op: 'moveSlide', target: {slide: 1}, to: 0},
    {op: 'moveSlide', target: {slide: 3}, to: 1},
  ])
  assert.deepEqual(result.order, ['ppt/slides/slide2.xml', 'ppt/slides/slide4.xml', 'ppt/slides/slide1.xml', 'ppt/slides/slide3.xml'])
  assert.equal(result.slides.length, 4)
})

test('slides bridge applies themes through the fenced server session and refreshes the full deck', {timeout: 30000}, async t => {
  const createSlidesBridge = await bundleBridge(t)
  const server = createSlidesMockServer({slideCount: 2})
  const {bridge} = await openBridge(createSlidesBridge, server, t)
  await bridge.api.openPptx(1280)

  const result = await bridge.api.applyTheme({
    name: 'Web theme',
    colors: {dk1: '#000000', lt1: '#FFFFFF', accent1: '#336699'},
    majorFont: 'Aptos Display',
    minorFont: 'Aptos',
    fitWidthPx: 1280,
  })

  assert.deepEqual(server.appliedOps(), [{
    op: 'applyTheme', name: 'Web theme', colors: {dk1: '#000000', lt1: '#FFFFFF', accent1: '#336699'},
    majorFont: 'Aptos Display', minorFont: 'Aptos',
  }])
  assert.equal(result.length, 2)
  assert.equal(await bridge.api.isDirty(), true)
})

test('slides bridge saves rehearsal advance times through one fenced server transaction', {timeout: 30000}, async t => {
  const createSlidesBridge = await bundleBridge(t)
  const server = createSlidesMockServer({slideCount: 3})
  const {bridge} = await openBridge(createSlidesBridge, server, t)
  await bridge.api.openPptx(1280)

  assert.equal(await bridge.api.setAdvanceTimes({times: [
    {slideIndex: 0, ms: 2500},
    {slideIndex: 2, ms: null},
  ]}), true)

  assert.deepEqual(server.appliedOps(), [
    {op: 'setAdvanceTime', target: {slide: 0}, ms: 2500},
    {op: 'setAdvanceTime', target: {slide: 2}, ms: null},
  ])
  assert.equal(await bridge.api.isDirty(), true)
})

test('slides bridge routes GenOffice background and picture edits through apply_ops', {timeout: 30000}, async t => {
  const createSlidesBridge = await bundleBridge(t)
  const server = createSlidesMockServer({slideCount: 2})
  const {bridge} = await openBridge(createSlidesBridge, server, t)
  await bridge.api.openPptx(1280)

  await bridge.api.editBackground({slideIndex: 0, fitWidthPx: 1280, kind: 'solid', color: '#123456'})
  await bridge.api.editBackground({slideIndex: 0, fitWidthPx: 1280, kind: 'gradient', from: '#000000', to: '#FFFFFF', angleDeg: 45})
  await bridge.api.editBackground({slideIndex: 0, fitWidthPx: 1280, kind: 'reset'})
  await bridge.api.editBackground({slideIndex: -1, fitWidthPx: 1280, kind: 'hideGraphics', hidden: true})
  await bridge.api.editPictureSrcRect({slideIndex: 0, sourceId: 'e1-picture', srcRect: {l: 0.1, t: 0.2, r: 0.1, b: 0.2}, boxPx: {x: 10, y: 20, w: 30, h: 40}, fitWidthPx: 1280})
  await bridge.api.editPictureOpacity({slideIndex: 0, sourceId: 'e1-picture', opacity: 0.6})

  assert.deepEqual(server.appliedOps(), [
    {op: 'setBackground', target: {slide: 0}, kind: 'solid', color: '#123456'},
    {op: 'setBackground', target: {slide: 0}, kind: 'gradient', from: '#000000', to: '#FFFFFF', angleDeg: 45},
    {op: 'setBackground', target: {slide: 0}, kind: 'reset'},
    {op: 'setBackground', target: {slide: 0}, kind: 'graphics', hidden: true},
    {op: 'setBackground', target: {slide: 1}, kind: 'graphics', hidden: true},
    {op: 'setPictureSrcRect', target: {slide: 0, el: 'e1-picture'}, srcRect: {l: 0.1, t: 0.2, r: 0.1, b: 0.2}, box: {x: 95250, y: 190500, cx: 285750, cy: 381000}},
    {op: 'setPictureOpacity', target: {slide: 0, el: 'e1-picture'}, opacity: 0.6},
  ])
})

test('slides bridge inserts GenOffice charts and SmartArt with slide-space geometry', {timeout: 30000}, async t => {
  const createSlidesBridge = await bundleBridge(t)
  const server = createSlidesMockServer({slideCount: 1})
  const {bridge} = await openBridge(createSlidesBridge, server, t)
  await bridge.api.openPptx(1280)

  const chart = await bridge.api.addChart({slideIndex: 0, kind: 'barH', categories: ['A', 'B'], series: [{name: 'Sales', values: [3, 5]}], xPx: 10, yPx: 20, wPx: 300, hPx: 180, fitWidthPx: 1280})
  const diagram = await bridge.api.addSmartArt({slideIndex: 0, layout: 'process', items: ['Plan', 'Build'], xPx: 20, yPx: 40, wPx: 400, hPx: 100, fitWidthPx: 1280})

  assert.equal(typeof chart?.sourceId, 'string')
  assert.equal(typeof diagram?.sourceId, 'string')
  assert.deepEqual(server.appliedOps().map(({op, ...rest}) => ({op, ...rest})), [
    {op: 'addChart', target: {slide: 0}, kind: 'bar', barDir: 'bar', categories: ['A', 'B'], series: [{name: 'Sales', values: [3, 5]}], offset: {x: 95250, y: 190500, cx: 2857500, cy: 1714500}},
    {op: 'addSmartArt', target: {slide: 0}, layout: 'process', items: ['Plan', 'Build'], offset: {x: 190500, y: 381000, cx: 3810000, cy: 952500}},
  ])
})

test('slides bridge only confirms an imported chart edit after the user accepts', {timeout: 30000}, async t => {
  const createSlidesBridge = await bundleBridge(t)
  const server = createSlidesMockServer({slideCount: 1})
  const host = createSessionFileHost({fetchImpl: server.fetchImpl})
  t.after(() => host.dispose())
  await host.open(server.file().fileId)
  await host.acquireLease(server.file().fileId)
  const requests = []
  let accepted = false, prompts = 0
  const bridge = createSlidesBridge(host, server.file().fileId, {language: 'en', theme: 'light'}, {
    confirmImportedChart: () => {prompts++; return accepted},
    fetchImpl: async (url, init) => {
      if (!String(url).endsWith('/chart-edit')) return server.fetchImpl(url, init)
      const body = JSON.parse(init.body)
      requests.push(body)
      if (!body.confirmed) return Response.json({confirmationRequired: true})
      return Response.json({generation: 1, dirty: true, slide: {nodes: []}, sourceId: 'updated-chart', history: {canUndo: true, canRedo: false}})
    },
  })
  t.after(() => bridge.dispose())
  await bridge.api.openPptx(1280)
  const edit = {slideIndex: 0, sourceId: 'imported-chart', title: 'Sales'}
  assert.equal(await bridge.api.editChart(edit), null)
  assert.equal(prompts, 1)
  assert.equal(requests.length, 1)
  assert.equal(await bridge.api.isDirty(), false)
  accepted = true
  assert.equal((await bridge.api.editChart(edit))?.sourceId, 'updated-chart')
  assert.equal(prompts, 2)
  assert.deepEqual(requests.map(({generation, confirmed, patch}) => ({generation, confirmed, patch})), [
    {generation: 0, confirmed: undefined, patch: {title: 'Sales'}},
    {generation: 0, confirmed: undefined, patch: {title: 'Sales'}},
    {generation: 0, confirmed: true, patch: {title: 'Sales'}},
  ])
  assert.equal(await bridge.api.isDirty(), true)
})

test('slides bridge routes configured GenOffice search tools to the shared SaaS assistant API', {timeout: 30000}, async t => {
  const createSlidesBridge = await bundleBridge(t)
  const server = createSlidesMockServer({slideCount: 1}), searches = []
  const host = createSessionFileHost({fetchImpl: server.fetchImpl})
  t.after(() => host.dispose())
  await host.open(server.file().fileId)
  const bridge = createSlidesBridge(host, server.file().fileId, {language: 'en', theme: 'light'}, {
    fetchImpl: server.fetchImpl,
    searchApi: {
      webSearch: async (query, maxResults) => {searches.push({kind: 'web', query, maxResults}); return {results: []}},
      imageSearch: async (query, maxResults) => {searches.push({kind: 'image', query, maxResults}); return {images: []}},
    },
  })
  t.after(() => bridge.dispose())
  await bridge.api.webSearch('GenOffice', 3)
  await bridge.api.imageSearch('office desk', 2)
  assert.deepEqual(searches, [
    {kind: 'web', query: 'GenOffice', maxResults: 3},
    {kind: 'image', query: 'office desk', maxResults: 2},
  ])
})

test('slides bridge routes configured GenOffice media tools to the shared SaaS assistant API', {timeout: 30000}, async t => {
  const createSlidesBridge = await bundleBridge(t)
  const server = createSlidesMockServer({slideCount: 1}), calls = []
  const host = createSessionFileHost({fetchImpl: server.fetchImpl})
  t.after(() => host.dispose())
  await host.open(server.file().fileId)
  const bridge = createSlidesBridge(host, server.file().fileId, {language: 'en', theme: 'light'}, {
    fetchImpl: server.fetchImpl,
    mediaApi: {
      generateImage: async input => {calls.push({kind: 'generate', input}); return {url: 'data:image/png;base64,aGVsbG8='}},
      analyzeMedia: async input => {calls.push({kind: 'analyze', input}); return {text: 'Analysis'}},
    },
  })
  t.after(() => bridge.dispose())
  const generated = await bridge.api.generateImage({prompt: 'red kite', model: 'desktop override'})
  assert.match(generated.url, /^https:\/\/generated-image\.invalid\//)
  assert.equal(generated.previewUrl, 'data:image/png;base64,aGVsbG8=')
  assert.deepEqual(await bridge.api.analyzeMedia({mediaUrls: ['https://example.com/photo.jpg'], requirements: 'Describe it'}), {text: 'Analysis'})
  assert.deepEqual(calls, [
    {kind: 'generate', input: {prompt: 'red kite'}},
    {kind: 'analyze', input: {mediaUrls: ['https://example.com/photo.jpg'], requirements: 'Describe it'}},
  ])
})

test('slides assistant puts generated images into slides and generated pages using a short document reference', async t => {
  const createSlidesBridge = await bundleBridge(t)
  const server = createSlidesMockServer({slideCount:1})
  const image = new PNG({width:32,height:32})
  let sample = 17
  for(let i=0;i<image.data.length;i++){
    sample = (Math.imul(1664525,sample)+1013904223)>>>0
    image.data[i] = sample>>>24
  }
  const dataUrl = 'data:image/png;base64,'+PNG.sync.write(image).toString('base64')
  assert.ok(dataUrl.length>4096)
  const inputs = []
  const {bridge} = await openBridge(createSlidesBridge, server, t, {mediaApi:{
    async generateImage(input){inputs.push(input);return {url:dataUrl}},
    async fetchImage(){assert.fail('generated images must not use the network')},
  }})
  await bridge.api.openPptx(1280)
  const {url, previewUrl} = await bridge.api.generateImage({prompt:'Draw a kite'})
  assert.match(url, /^https:\/\/generated-image\.invalid\//)
  assert.equal(previewUrl, dataUrl)
  const inserted = await bridge.api.insertImageUrl({slideIndex:0,url,xPx:10,yPx:10,wPx:50,hPx:50,fitWidthPx:1280})
  assert.ok(inserted.slide.nodes.some(node=>node.type==='picture'))
  const replaced = await bridge.api.replacePictureUrl({slideIndex:0,sourceId:inserted.sourceId,url})
  assert.ok(replaced.nodes.some(node=>node.sourceId===inserted.sourceId && node.type==='picture'))
  const result = await bridge.api.localGeneratePage({specJson:JSON.stringify({elements:[{type:'image',url,x:10,y:10,w:50,h:50}]})})
  assert.deepEqual(result.imageFailures, [])
  const landed = await bridge.api.landGeneratedPages([result.marker], 1280, 'append')
  assert.ok(landed.slides[1].nodes.some(node=>node.type==='picture'))
  await bridge.api.generateImage({prompt:'Redraw it',referenceImageUrls:[url]})
  assert.deepEqual(inputs[1].referenceImageUrls,[dataUrl])
  assert.equal(await bridge.api.insertImageUrl({slideIndex:0,url:'https://generated-image.invalid/unknown',xPx:10,yPx:10,wPx:50,hPx:50,fitWidthPx:1280}),null)
})

test('slides bridge persists and reloads GenOffice style templates through the authenticated API', {timeout: 30000}, async t=>{
 const createSlidesBridge=await bundleBridge(t),server=createSlidesMockServer({slideCount:1})
 const {bridge}=await openBridge(createSlidesBridge,server,t)
 const value={topic:'Quarterly results',styleSkill:'Teal headings and restrained charts.',createdAt:'2026-11-19T00:00:00.000Z',layout:{canvas:{w:1280,h:720},cover:{title:{x:40,y:32,w:700,h:80,sizePt:30}}}}
 assert.deepEqual(await bridge.api.saveStyleTemplate('Annual / Report',value),{ok:true})
 assert.deepEqual(await bridge.api.listStyleTemplates(),[{name:'Annual _ Report',topic:value.topic,createdAt:value.createdAt}])
 assert.deepEqual(await bridge.api.loadStyleTemplate('Annual _ Report'),{ok:true,topic:value.topic,styleSkill:value.styleSkill,layout:value.layout})
})

test('slides bridge sends GenOffice image inserts and replacements through the fenced media route', {timeout: 30000}, async t => {
  const createSlidesBridge=await bundleBridge(t),server=createSlidesMockServer({slideCount:1})
  const base64='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lN8AAAAASUVORK5CYII='
  const fetched=[]
  const {bridge}=await openBridge(createSlidesBridge,server,t,{mediaApi:{fetchImage:async url=>{fetched.push(url);return {base64,mime:'image/png'}}}})
  await bridge.api.openPptx(1280)
  const inserted=await bridge.api.insertImageUrl({slideIndex:0,base64,ext:'png',xPx:30,yPx:40,wPx:100,hPx:80,fitWidthPx:1280})
  assert.match(inserted.sourceId,/^pic-/)
  assert.equal(inserted.slide.nodes.find(node=>node.sourceId===inserted.sourceId).type,'picture')
  assert.equal(await bridge.api.isDirty(),true)
  const replaced=await bridge.api.replacePictureUrl({slideIndex:0,sourceId:inserted.sourceId,base64,ext:'png',keepSrcRect:true})
  assert.equal(replaced.nodes.find(node=>node.sourceId===inserted.sourceId).type,'picture')
  const fromUrl=await bridge.api.insertImageUrl({slideIndex:0,url:'https://images.example/picture.png',xPx:10,yPx:10,wPx:50,hPx:50,fitWidthPx:1280})
  assert.match(fromUrl.sourceId,/^pic-/)
  assert.deepEqual(fetched,['https://images.example/picture.png'])
})

test('slides bridge lands generated pages with fetched images and preserves undo', {timeout: 30000}, async t => {
  const createSlidesBridge = await bundleBridge(t)
  const server = createSlidesMockServer({slideCount: 1})
  const url = 'https://images.example/picture.png'
  const fetched = []
  const {bridge} = await openBridge(createSlidesBridge, server, t, {mediaApi: {
    fetchImage: async source => {
      fetched.push(source)
      return {base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lN8AAAAASUVORK5CYII=', mime: 'image/png'}
    },
  }})
  await bridge.api.openPptx(1280)
  const generate = text => bridge.api.localGeneratePage({specJson: JSON.stringify({elements: [
    {type: 'text', x: 40, y: 40, w: 600, h: 120, paragraphs: [{runs: [{text}]}]},
    {type: 'image', url, x: 700, y: 40, w: 300, h: 300},
  ]})})
  const first = await generate('New title')
  assert.equal(first.ok, true)
  assert.equal(await bridge.api.isDirty(), false)
  const appended = await bridge.api.landGeneratedPages([first.marker], 1280, 'append')
  assert.equal(appended.appendedFrom, 1)
  assert.equal(appended.slides[1].nodes[0].text, 'New title')
  assert.equal(appended.slides[1].nodes[1].type, 'picture')
  const second = await generate('Inserted title')
  const inserted = await bridge.api.landGeneratedPages([second.marker], 1280, 'insert_at', 0)
  assert.equal(inserted.insertedIndex, 0)
  const third = await generate('Replacement title')
  const replaced = await bridge.api.landGeneratedPages([third.marker], 1280, 'replace_at', 0)
  assert.equal(replaced.replacedIndex, 0)
  assert.equal(replaced.slides[0].nodes[0].text, 'Replacement title')
  assert.equal(await bridge.api.isDirty(), true)
  assert.equal((await bridge.api.undo())[0].nodes[0].text, 'Inserted title')
  assert.equal((await bridge.api.undo()).length, 2)
  assert.equal((await bridge.api.undo()).length, 1)
  assert.deepEqual(fetched, [url, url, url])
})

test('slides bridge applies GenOffice edit scripts as one version-fenced server transaction', {timeout: 30000}, async t => {
  const createSlidesBridge = await bundleBridge(t)
  const server = createSlidesMockServer({slideCount: 1})
  const {bridge} = await openBridge(createSlidesBridge, server, t)
  await bridge.api.openPptx(1280)

  const result = await bridge.api.applyEditScript({
    slideIndex: 0,
    fitWidthPx: 1280,
    boxes: [{id: 'e1-title', x: 100, y: 80, w: 600, h: 90, rotation: 0}],
    edits: [{kind: 'text', id: 'e1-title', paragraphs: [{runs: [{text: 'Script edited'}]}]}],
  })

  assert.equal(result.slide.nodes.find(node => node.sourceId === 'e1-title').text, 'Script edited')
  assert.deepEqual(server.appliedOps(), [
    {op: 'setTransform', target: {slide: 0, el: 'e1-title'}, box: {x: 952500, y: 762000, cx: 5715000, cy: 857250}, rotDeg: 0},
    {op: 'setText', target: {slide: 0, el: 'e1-title'}, paragraphs: [{runs: [{text: 'Script edited'}]}]},
  ])
  assert.equal(await bridge.api.isDirty(), true)
})

test('slides bridge exposes atomic applyTxn results with the updated deck', {timeout: 30000}, async t => {
  const createSlidesBridge = await bundleBridge(t)
  const server = createSlidesMockServer({slideCount: 1})
  const {bridge} = await openBridge(createSlidesBridge, server, t)
  await bridge.api.openPptx(1280)

  const ops = [
    {op: 'setText', target: {slide: 0, el: 'e1-title'}, paragraphs: [{runs: [{text: 'Batch edited'}]}]},
  ]
  const dryRun = await bridge.api.applyTxn({ops, dryRun: true})
  assert.equal(dryRun.applied, false)
  assert.equal(dryRun.dryRun, true)
  assert.deepEqual(dryRun.plan, ['[0] setText'])
  assert.equal(await bridge.api.isDirty(), false)

  const result = await bridge.api.applyTxn({ops})

  assert.equal(result.applied, true)
  assert.equal(result.records[0].op, 'setText')
  assert.equal(result.slides[0].nodes.find(node => node.sourceId === 'e1-title').text, 'Batch edited')
  assert.equal(await bridge.api.isDirty(), true)
})

test('slides bridge reads speaker notes from the current draft after dry-run and undo', async t => {
  const createSlidesBridge = await bundleBridge(t)
  const server = createSlidesMockServer({slideCount: 1, initialNotes: 'Original notes'})
  const {bridge} = await openBridge(createSlidesBridge, server, t)
  await bridge.api.openPptx(1280)
  assert.equal(await bridge.api.getNotes(0), 'Original notes')
  await bridge.api.applyTxn({ops: [{op: 'setNotes', target: {slide: 0}, text: 'Preview only'}], dryRun: true})
  assert.equal(await bridge.api.getNotes(0), 'Original notes')
  assert.equal(await bridge.api.setNotes({slideIndex: 0, text: 'Updated notes'}), true)
  assert.equal(await bridge.api.getNotes(0), 'Updated notes')
  await bridge.api.undo()
  assert.equal(await bridge.api.getNotes(0), 'Original notes')
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
  const cited = createSlidesBridge({...host,isCurrentRevision:async()=>false},server.file().fileId,{language:'en'},{fetchImpl:server.fetchImpl})
  t.after(()=>cited.dispose())
  await assert.rejects(cited.takeover({isDirty:()=>false,reload:async()=>{reloads++;return true}},true),/cited revision/)
  assert.equal(reloads,1)
  assert.equal(host.getState(server.file().fileId).lease,null)
})

test('desktop-only slides operations reject asynchronously with an explicit unavailable error', {timeout: 30000}, async t => {
  const createSlidesBridge = await bundleBridge(t)
  const server = createSlidesMockServer({slideCount: 1})
  const {bridge} = await openBridge(createSlidesBridge, server, t)
  const desktopOnly = ['printSlides', 'exportPdf', 'exportImages', 'pickExportDir', 'pickExportPdfPath', 'pickExportVideoPath', 'videoFileOpen', 'savePicture', 'listPrinters', 'printerOptions', 'fontInstallLocal', 'fontCatalog', 'fontDownload', 'insertMedia', 'addMediaBytes', 'pickModel3d', 'addModel3d', 'openPptxPath', 'newBlank', 'saveAs', 'presenterStart', 'aiStream', 'webSearch']
  for (const method of desktopOnly) {
    assert.equal(typeof bridge.api[method], 'function', method)
    let operation
    assert.doesNotThrow(() => { operation = bridge.api[method]({}) }, method)
    await assert.rejects(operation, error => error.message.length > 0 && !/is not a function/.test(error.message), method)
  }
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
  assert.deepEqual(await bridge.api.getLayouts(), {layouts: [{path: 'ppt/slideLayouts/slideLayout1.xml', name: 'Title Slide', layoutType: 'title', placeholders: []}], size: {cx: 12192000, cy: 6858000}})
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

for (const lost of [false,true]) test(`disposed slides save rejects its late ${lost?'unknown':'committed'} outcome without resurrecting recovery`, {timeout:30000}, async t=>{
 const createSlidesBridge=await bundleBridge(t),server=createSlidesMockServer({slideCount:1})
 const reached=Promise.withResolvers(),resume=Promise.withResolvers(),keys=[]
 const send=async(path,init={})=>{const response=await server.fetchImpl(path,init);if(String(path).endsWith('/commits')){keys.push(JSON.parse(init.body).idempotencyKey);if(keys.length===1){reached.resolve();await resume.promise;if(lost){await response.arrayBuffer();throw new TypeError('lost commit')}}}return response}
 const host=createSessionFileHost({fetchImpl:send});t.after(()=>host.dispose());await host.open(server.file().fileId);await host.acquireLease(server.file().fileId)
 let changes=0
 const bridge=createSlidesBridge(host,server.file().fileId,{language:'en',theme:'light'},{fetchImpl:send,onChange:()=>changes++});t.after(()=>bridge.dispose())
 await bridge.api.openPptx(1280);await bridge.api.editText({slideIndex:0,sourceId:'e1-title',paragraphs:[{runs:[{text:'kept'}]}]})
 let outcome
 const saving=bridge.api.save().then(value=>{outcome={value}},error=>{outcome={error}})
 await reached.promise;bridge.dispose();const changesAtDispose=changes;resume.resolve()
 await new Promise(resolve=>setImmediate(resolve))
 assert.equal(bridge.needsConfirmation(),false,'unmounted view must not recreate receipt recovery')
 assert.equal(changes,changesAtDispose,'no UI notification after teardown')
 assert.ok(outcome?.error,'late completion must reject, not hang or report success')
 assert.equal(outcome.error.code,'UNAVAILABLE');await saving
 assert.equal(host.getState(server.file().fileId).status,lost?'unknown':'idle','host retains durable outcome; teardown cannot undo commit')
 await bridge.confirmSave();assert.equal(bridge.needsConfirmation(),false);assert.equal(changes,changesAtDispose)
 if(lost){
  const receipt=await host.reconcileSlides(server.file().fileId)
  assert.equal(receipt.revision,server.file().revision,'independent host reconciliation still sees the committed head')
  assert.equal(host.getState(server.file().fileId).status,'idle')
 }
 assert.equal(new Set(keys).size,1,'explicit reconciliation only replays the same idempotent commit')
 assert.equal(keys.length,lost?2:1)
 assert.equal(server.preparations(),1,'disposal and reconciliation never re-export a new snapshot')
})

for(const lost of [false,true]) test(`disposing during ${lost?'unknown':'committed'} receipt confirmation never notifies the old renderer`, {timeout:30000}, async t=>{
 const createSlidesBridge=await bundleBridge(t),server=createSlidesMockServer({slideCount:1})
 const reached=Promise.withResolvers(),resume=Promise.withResolvers(),keys=[];let commits=0
 const send=async(path,init={})=>{
  const response=await server.fetchImpl(path,init)
  if(String(path).endsWith('/commits')){
   keys.push(JSON.parse(init.body).idempotencyKey)
   if(++commits===1){await response.arrayBuffer();throw new TypeError('lost commit')}
   if(commits===2){reached.resolve();await resume.promise;if(lost){await response.arrayBuffer();throw new TypeError('lost confirmation')}}
  }
  return response
 }
 const host=createSessionFileHost({fetchImpl:send});t.after(()=>host.dispose());await host.open(server.file().fileId);await host.acquireLease(server.file().fileId)
 let changes=0
 const bridge=createSlidesBridge(host,server.file().fileId,{language:'en',theme:'light'},{fetchImpl:send,onChange:()=>changes++});t.after(()=>bridge.dispose())
 await bridge.api.openPptx(1280);await bridge.api.editText({slideIndex:0,sourceId:'e1-title',paragraphs:[{runs:[{text:'kept'}]}]})
 const saving=bridge.api.save().then(value=>({value}),error=>({error}))
 const deadline=Date.now()+10000
 while(!bridge.needsConfirmation()){assert.ok(Date.now()<deadline);await new Promise(resolve=>setImmediate(resolve))}
 const confirming=bridge.confirmSave().then(value=>({value}),error=>({error}));await reached.promise;bridge.dispose();const before=changes;resume.resolve()
 const confirmation=await confirming
 assert.equal(confirmation.error?.code,'UNAVAILABLE','disposed confirmation rejects instead of reporting success')
 assert.equal(changes,before,'no notification after disposal during reconciliation')
 assert.equal((await saving).error?.code,'UNAVAILABLE');assert.equal(bridge.needsConfirmation(),false)
 assert.equal(host.getState(server.file().fileId).status,lost?'unknown':'idle')
 if(lost)await host.reconcileSlides(server.file().fileId)
 assert.equal(host.getState(server.file().fileId).status,'idle');assert.equal(server.preparations(),1)
 assert.equal(new Set(keys).size,1);assert.equal(commits,lost?3:2)
})

test('analysis guards are rechecked after CSRF await and guarded saves expose real receipts',async t=>{
 const createSlidesBridge=await bundleBridge(t),server=createSlidesMockServer({slideCount:1})
 const {host,bridge}=await openBridge(createSlidesBridge,server,t)
 await bridge.api.openPptx(960)
 await bridge.api.editText({slideIndex:0,sourceId:'e1-title',paragraphs:[{runs:[{text:'analysis'}]}]})
 assert.equal(await bridge.guardedSave(()=>false,()=>bridge.api.save().then(r=>r.ok)),false)
 assert.equal(server.preparations(),0)
 const previous=host.getState(server.file().fileId).revision.revision
 assert.equal(await bridge.guardedSave(()=>true,async()=>{
  await assert.rejects(bridge.api.editText({slideIndex:0,sourceId:'e1-title',paragraphs:[{runs:[{text:'late mutation'}]}]}),{code:'UNAVAILABLE'})
  return (await bridge.api.save()).ok
 }),true)
 assert.notEqual(bridge.getReceipt().revision,previous)
 assert.equal(bridge.getReceipt().revision,server.file().revision)
 let allowed=true,applies=0,proofs=0
 const otherServer=createSlidesMockServer({slideCount:1}),otherHost=createSessionFileHost({fetchImpl:otherServer.fetchImpl})
 t.after(()=>otherHost.dispose());await otherHost.open(otherServer.file().fileId);await otherHost.acquireLease(otherServer.file().fileId)
 const second=createSlidesBridge(otherHost,otherServer.file().fileId,{language:'en',theme:'light'},{fetchImpl:async(path,init)=>{
  if(String(path).endsWith('/auth/csrf')&&++proofs>1)allowed=false
  if(String(path).endsWith('/apply')){applies++;return new Response('{}',{status:403,headers:{'content-type':'application/json'}})}
  return otherServer.fetchImpl(path,init)
 }})
 t.after(()=>second.dispose());await second.api.openPptx(960)
 await assert.rejects(second.guardedApply(()=>allowed,async()=>{await second.api.applyTxn({ops:[{op:'addElement'}]});return true}),{code:'UNAVAILABLE'})
 assert.equal(applies,1,'revocation after renewed CSRF prevents a second mutation dispatch')
})

test('PPTX analysis target applies uncommitted delivery and reports only the explicit saved receipt',async t=>{
 const {createAnalysisDocumentTarget}=await import('../../../../packages/browser-host/src/analysis-document-target.ts')
 const {captureSlideAnalysis}=await import('../../../slides/src/renderer/analysis-insert.ts')
 const createSlidesBridge=await bundleBridge(t),server=createSlidesMockServer({slideCount:1}),{host,bridge}=await openBridge(createSlidesBridge,server,t)
 const opened=await bridge.api.openPptx(960);let identity=opened.slides,held=0
 const native={captureAnalysis:()=>captureSlideAnalysis({current:()=>({identity,slideId:'slide1',index:0,selection:'[]',generation:bridge.getAnalysisGeneration(),width:960,height:540}),hold:()=>held++,run:(ops,check)=>bridge.guardedApply(check,async()=>{const r=await bridge.api.applyTxn({ops});if(!r?.applied||!r.slides)return false;identity=r.slides;return true})})}
 const target=createAnalysisDocumentTarget({fileId:server.file().fileId,format:'pptx',state:()=>host.getState(server.file().fileId),editor:()=>native,receipt:()=>bridge.getReceipt(),verifyAuthority:async()=>{await host.renewLease(server.file().fileId)},save:check=>bridge.guardedSave(check,()=>bridge.api.save().then(r=>r.ok))})
 t.after(()=>target.dispose())
 const result=await target.apply(target.capture(),{kind:'text',text:'<b>literal</b> =SUM(A1)'},{artifactId:'delivery',sha256:'a'.repeat(64)},()=>true)
 assert.equal(result.status,'applied_uncommitted');assert.equal(held,1);assert.equal(server.preparations(),0)
 const saved=await target.save(result.applicationId,()=>true)
 assert.equal(saved.status,'saved');assert.equal(saved.receipt.revision,server.file().revision);assert.equal(server.preparations(),1)
 const next=await target.apply(target.capture(),{kind:'text',text:'second'},{artifactId:'delivery2',sha256:'b'.repeat(64)},()=>true)
 identity=[...identity]
 assert.deepEqual(await target.save(next.applicationId,()=>true),{status:'not_confirmed',reason:'newer_edits'})
 assert.equal(server.preparations(),1)
})

test('guarded analysis save remains unconfirmed until its original unknown receipt is reconciled',async t=>{
 const createSlidesBridge=await bundleBridge(t),server=createSlidesMockServer({slideCount:1});let dropped=false
 const fetchImpl=async(path,init)=>{const response=await server.fetchImpl(path,init);if(!dropped&&String(path).endsWith('/commits')){dropped=true;await response.arrayBuffer();throw new TypeError('lost analysis save receipt')}return response}
 const host=createSessionFileHost({fetchImpl});t.after(()=>host.dispose());await host.open(server.file().fileId);await host.acquireLease(server.file().fileId)
 const bridge=createSlidesBridge(host,server.file().fileId,{language:'en',theme:'light'},{fetchImpl});t.after(()=>bridge.dispose())
 await bridge.api.openPptx(960);await bridge.api.editText({slideIndex:0,sourceId:'e1-title',paragraphs:[{runs:[{text:'analysis'}]}]})
 let confirmed=false
 const saving=bridge.guardedSave(()=>true,async()=>{const r=await bridge.api.save();confirmed=r.ok;return r.ok})
 const deadline=Date.now()+5000
 while(!bridge.needsConfirmation()){assert.ok(Date.now()<deadline);await new Promise(resolve=>setTimeout(resolve,10))}
 assert.equal(confirmed,false);assert.equal(bridge.getReceipt(),null)
 await bridge.confirmSave();assert.equal(await saving,true);assert.equal(bridge.getReceipt().revision,server.file().revision);assert.equal(server.preparations(),1)
})

test('Ribbon slide size uses the native server op, adopts resized deck dimensions and requires the edit lease',async t=>{
 const createSlidesBridge=await bundleBridge(t),server=createSlidesMockServer({slideCount:1})
 const host=createSessionFileHost({fetchImpl:server.fetchImpl});t.after(()=>host.dispose());await host.open(server.file().fileId);await host.acquireLease(server.file().fileId)
 const calls=[];let changed=0
 const bridge=createSlidesBridge(host,server.file().fileId,{language:'en',theme:'light'},{onChange:()=>changed++,fetchImpl:async(url,init)=>{
  if(String(url).endsWith('/slides/apply')){
   const body=JSON.parse(init.body);calls.push(body)
   return new Response(JSON.stringify({generation:1,dirty:true,size:{cx:9144000,cy:6858000},changed:[0],history:{canUndo:true,canRedo:false}}),{headers:{'content-type':'application/json'}})
  }
  return server.fetchImpl(url,init)
 }})
 t.after(()=>bridge.dispose());await bridge.api.openPptx(960)
 const result=await bridge.api.setSlideSize({cx:9144000,cy:6858000})
 assert.ok(Array.isArray(result));assert.equal(result.length,1)
 assert.deepEqual(calls[0].ops,[{op:'setSlideSize',cx:9144000,cy:6858000}])
 assert.equal(calls[0].editorId,host.getState(server.file().fileId).lease.editorId)
 assert.deepEqual(await bridge.api.getSlideSize(),{cx:9144000,cy:6858000})
 assert.equal(bridge.isDirty(),true);assert.equal(changed,1)
 await host.releaseLease(server.file().fileId)
 assert.equal(await bridge.api.setSlideSize({cx:12192000,cy:6858000}),null)
 assert.equal(calls.length,1)
})

test('links and animations bridge forwards full replacements and reads native saved values instead of empty placeholders',async t=>{
 const createSlidesBridge=await bundleBridge(t),server=createSlidesMockServer({slideCount:1}),host=createSessionFileHost({fetchImpl:server.fetchImpl});t.after(()=>host.dispose())
 await host.open(server.file().fileId);await host.acquireLease(server.file().fileId)
 const calls=[],link={kind:'url',url:'https://example.com'},items=[{sourceId:'e1-title',effect:'fade',trigger:'onClick',durationMs:500,delayMs:0}]
 const bridge=createSlidesBridge(host,server.file().fileId,{language:'en',theme:'light'},{fetchImpl:async(url,init)=>{
  const method=String(url).split('/').at(-1),body=init?.body?JSON.parse(init.body):null
  if(['apply','animations','links'].includes(method)){
   calls.push({method,body})
   const value=method==='apply'?{generation:calls.filter(call=>call.method==='apply').length,dirty:true,changed:[0]}:method==='links'?[{sourceId:'e1-title',target:link}]:items.map(item=>({...item,targetName:'Title'}))
   return new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}})
  }
  return server.fetchImpl(url,init)
 }})
 t.after(()=>bridge.dispose());await bridge.api.openPptx(960)
 assert.ok(await bridge.api.setLink({slideIndex:0,sourceId:'e1-title',target:link}))
 assert.equal(await bridge.api.setAnimations({slideIndex:0,items}),true)
 assert.deepEqual(await bridge.api.getLink(0,'e1-title'),link)
 assert.equal((await bridge.api.getAnimations(0))[0].durationMs,500)
 assert.deepEqual(calls.filter(call=>call.method==='apply').map(call=>call.body.ops),[[{op:'setLink',target:{slide:0,el:'e1-title'},link}],[{op:'setAnimations',target:{slide:0},items}]])
 assert.ok(calls.every(call=>call.body.editorId&&call.body.leaseEpoch===1))
 await host.releaseLease(server.file().fileId)
 assert.equal(await bridge.api.setAnimations({slideIndex:0,items:[]}),false)
 assert.equal(await bridge.api.setLink({slideIndex:0,sourceId:'e1-title',target:null}),null)
 assert.equal(calls.filter(call=>call.method==='apply').length,2)
})

test('native read calls serialize against writes and queued reads use the adopted local generation',async t=>{
 const createSlidesBridge=await bundleBridge(t),server=createSlidesMockServer({slideCount:1}),host=createSessionFileHost({fetchImpl:server.fetchImpl});t.after(()=>host.dispose());await host.open(server.file().fileId);await host.acquireLease(server.file().fileId)
 const started=Promise.withResolvers(),release=Promise.withResolvers(),calls=[];let active=0
 const bridge=createSlidesBridge(host,server.file().fileId,{language:'en',theme:'light'},{fetchImpl:async(url,init)=>{
  const method=String(url).split('/').at(-1)
  if(['apply','animations','links','run-links'].includes(method)){
   const body=JSON.parse(init.body);calls.push({method,generation:body.generation});active++
   assert.equal(active,1,'Server session admits only one operation at a time')
   if(method==='apply'){started.resolve();await release.promise}
   active--
   return new Response(JSON.stringify(method==='apply'?{generation:1,dirty:true,changed:[0]}:method==='run-links'?[{sourceId:'e1-title',paraIndex:0,runIndex:1,target:{kind:'slide',slideIndex:0}}]:[]),{headers:{'content-type':'application/json'}})
  }
  return server.fetchImpl(url,init)
 }})
 t.after(()=>bridge.dispose());await bridge.api.openPptx(960)
 const write=bridge.api.setAnimations({slideIndex:0,items:[]});await started.promise
 const reads=Promise.all([bridge.api.getAnimations(0),bridge.api.getSlideLinks(0),bridge.api.getRunLinks(0)])
 release.resolve();assert.equal(await write,true)
 assert.deepEqual((await reads)[2],[{sourceId:'e1-title',paraIndex:0,runIndex:1,target:{kind:'slide',slideIndex:0}}])
 assert.deepEqual(calls,[{method:'apply',generation:0},{method:'animations',generation:1},{method:'links',generation:1},{method:'run-links',generation:1}])
})

test('a mutation queued behind reopening cannot edit a replaced session or report false success',async t=>{
 const createSlidesBridge=await bundleBridge(t),server=createSlidesMockServer({slideCount:1}),host=createSessionFileHost({fetchImpl:server.fetchImpl});t.after(()=>host.dispose());await host.open(server.file().fileId);await host.acquireLease(server.file().fileId)
 let hold=false,writes=0;const started=Promise.withResolvers(),release=Promise.withResolvers()
 const bridge=createSlidesBridge(host,server.file().fileId,{language:'en',theme:'light'},{fetchImpl:async(url,init)=>{
  if(String(url).endsWith('/slides/open')&&hold){started.resolve();await release.promise}
  if(String(url).endsWith('/slides/apply'))writes++
  return server.fetchImpl(url,init)
 }})
 t.after(()=>bridge.dispose());await bridge.api.openPptx(960);hold=true
 const reopened=bridge.api.openPptx(960);await started.promise
 const write=bridge.api.setAnimations({slideIndex:0,items:[]})
 release.resolve();await reopened
 assert.equal(await write,false)
 assert.equal(writes,0);assert.equal(bridge.isDirty(),false)
})


test('snapshot restore cannot target the old session while reopening',async t=>{
 const createSlidesBridge=await bundleBridge(t),server=createSlidesMockServer({slideCount:1}),host=createSessionFileHost({fetchImpl:server.fetchImpl});t.after(()=>host.dispose());await host.open(server.file().fileId);await host.acquireLease(server.file().fileId)
 let hold=false,writes=0;const started=Promise.withResolvers(),release=Promise.withResolvers()
 const bridge=createSlidesBridge(host,server.file().fileId,{language:'en',theme:'light'},{fetchImpl:async(url,init)=>{
  if(String(url).endsWith('/slides/open')&&hold){started.resolve();await release.promise}
  if(String(url).endsWith('/slides/animations'))return new Response('[]',{headers:{'content-type':'application/json'}})
  if(String(url).endsWith('/slides/snapshot-restore')){writes++;return new Response(JSON.stringify({generation:1,dirty:true,slides:[],history:{canUndo:true,canRedo:false}}),{headers:{'content-type':'application/json'}})}
  return server.fetchImpl(url,init)
 }})
 t.after(()=>bridge.dispose());await bridge.api.openPptx(960);hold=true
 const reopened=bridge.api.openPptx(960);await started.promise
 const write=bridge.api.aiSnapshotRestore(1).then(value=>({value}),error=>({error}))
 release.resolve();await reopened
 assert.equal((await write).error?.code,'CONFLICT')
 assert.equal(writes,0);assert.equal(bridge.isDirty(),false)
 await bridge.api.getAnimations(0)
})


test('chart data and theme color reads use the fenced native routes and localized labels',async t=>{
 const createSlidesBridge=await bundleBridge(t),server=createSlidesMockServer({slideCount:1}),host=createSessionFileHost({fetchImpl:server.fetchImpl});t.after(()=>host.dispose());await host.open(server.file().fileId);await host.acquireLease(server.file().fileId)
 const calls=[],data={kind:'bar',title:'Live',categories:['Q1'],series:[{name:'Sales',values:[8]}],seriesColors:[],pointColors:[]}
 const bridge=createSlidesBridge(host,server.file().fileId,{language:'zh',theme:'light'},{fetchImpl:async(url,init)=>{
  const method=String(url).split('/').at(-1)
  if(['chart-data','chart-color-schemes'].includes(method)){calls.push({method,...JSON.parse(init.body)});return new Response(JSON.stringify(method==='chart-data'?data:[{key:'default',colors:[]},{key:'mono-accent1',colors:['#123456']}]),{headers:{'content-type':'application/json'}})}
  return server.fetchImpl(url,init)
 }})
 t.after(()=>bridge.dispose());await bridge.api.openPptx(960)
 assert.deepEqual(await bridge.api.getChartData(0,'e_chart'),data)
 assert.deepEqual(await bridge.api.getChartColorSchemes(),[{key:'default',label:'主题默认',colors:[]},{key:'mono-accent1',label:'单色 1',colors:['#123456']}])
 assert.equal(calls[0].sourceId,'e_chart');assert.equal(calls[0].index,0);assert.equal(calls[0].generation,0);assert.equal(calls[0].editorId,host.getState(server.file().fileId).lease.editorId)
})

test('local PPTX pictures use native image mutations and reject a stale file selection', async t => {
  const createSlidesBridge = await bundleBridge(t)
  const server = createSlidesMockServer({slideCount: 1})
  const fileId = server.file().fileId
  const host = createSessionFileHost({fetchImpl: server.fetchImpl})
  t.after(() => host.dispose())
  await host.open(fileId)
  await host.acquireLease(fileId)
  const png = PNG.sync.write(new PNG({width: 160, height: 90}))
  const choose = () => new File([png], 'picture.png', {type: 'image/png'})
  let pick = async () => choose()
  const requests = []
  const bridge = createSlidesBridge(host, fileId, {language: 'en', theme: 'light'}, {
    pickPicture: () => pick(),
    fetchImpl(url, init) {
      if (String(url).endsWith('/media')) requests.push(JSON.parse(init.body))
      return server.fetchImpl(url, init)
    },
  })
  t.after(() => bridge.dispose())
  await bridge.api.openPptx(960)
  const inserted = await bridge.api.insertImage(0, 960)
  assert.ok(inserted.sourceId)
  assert.ok(inserted.slide.nodes.some(node => node.sourceId === inserted.sourceId && node.type === 'picture'))
  const picked = await bridge.api.pickPictureFile()
  const updated = await bridge.api.replacePictureBytes({slideIndex: 0, sourceId: inserted.sourceId, ...picked})
  assert.ok(updated.nodes.some(node => node.sourceId === inserted.sourceId && node.type === 'picture'))
  assert.deepEqual(requests.map(({mode, generation}) => [mode, generation]), [['insert', 0], ['replace', 1]])
  assert.deepEqual(Buffer.from(requests[0].bytesBase64, 'base64'), png)
  assert.equal(requests[0].wPx / requests[0].hPx, 160 / 90)
  assert.equal(requests[0].xPx * 2 + requests[0].wPx, 960)
  assert.equal(await bridge.api.isDirty(), true)

  let completePick
  pick = () => new Promise(resolve => { completePick = resolve })
  const stale = bridge.api.insertImage(0, 960)
  await bridge.api.editText({slideIndex: 0, sourceId: 'e1-title', paragraphs: [{runs: [{text: 'new generation'}]}]})
  completePick(choose())
  assert.equal(await stale, null)
  pick = async () => null
  assert.equal(await bridge.api.insertImage(0, 960), null)
  pick = async () => new File(['invalid image'], 'picture.png', {type: 'image/png'})
  assert.deepEqual(await bridge.api.insertImage(0, 960), {error:'unsupported', ext:'png'})
  await host.releaseLease(fileId)
  pick = async () => { throw new Error('A read-only editor must not open a picker') }
  assert.equal(await bridge.api.insertImage(0, 960), null)
  assert.equal(requests.length, 2)
})
