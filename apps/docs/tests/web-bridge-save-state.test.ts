import {createDocsBridge} from '../../web/src/editors/docs-bridge'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { Editor } from '@tiptap/core'
import { parseDocx, readSections } from '@genoffice/docx-engine'
import { buildDocx, TABLE_XML } from '../../../packages/docx-engine/tests/helpers/build-docx'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { blocksToPmDoc, pmDocOptions } from '../src/renderer/editor/convert'
import { buildDocBytes, noteDocumentSwapped, save, type FileActionContext } from '../src/renderer/file-actions'
import { EMPTY_HF_VARIANTS } from '../src/renderer/doc-state'
import { DraftLanding } from '../src/renderer/ai/doc-writer'

;(globalThis as { CSS?: unknown }).CSS ??= { escape: (s: string) => s }

const dirs: string[] = []
const editors: Editor[] = []
afterEach(async () => {
  for (const editor of editors.splice(0)) editor.destroy()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

const paragraph = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`
const first = paragraph('Unchanged opening paragraph.')
const last = paragraph('Unchanged closing paragraph.')
const bodyXml = first + TABLE_XML + paragraph('Respond within forty-eight (48) hours.') + last

async function fixture(tracking: boolean) {
  noteDocumentSwapped()
  const bytes = await buildDocx({ bodyXml })
  const parsed = await parseDocx(bytes)
  const dir = await mkdtemp(join(tmpdir(), 'genoffice-save-tracked-'))
  dirs.push(dir)
  const path = join(dir, 'fixture.docx')
  await writeFile(path, bytes)
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    editorProps: { handleScrollToSelection: () => true },
    content: blocksToPmDoc(parsed.blocks, readSections(parsed), pmDocOptions(parsed)),
  })
  editors.push(editor)
  editor.storage.trackChanges.enabled = tracking
  const state = {
    editor,
    doc: { parsed, filePath: path, fileName: 'fixture.docx', hash: 'fixture' },
    dirtyRef: { current: false },
    saveInFlightRef: { current: false },
    saveIncompleteRef: { current: false },
    inkAnnotations: [],
    sections: readSections(parsed),
    sectionsDirty: [],
    pgNumDirtySections: [],
    hfVariants: EMPTY_HF_VARIANTS,
    hfVariantsDirty: [],
    sectionHfEdits: {},
    hfLinks: {},
    styleUpserts: {},
    pendingNumbering: { newDefs: [], restartNums: [] },
  }
  const noop = () => {}
  const ctx = new Proxy(state, {
    get(target, prop) {
      if (prop === 'setDoc')
        return (updater: (prev: typeof state.doc) => typeof state.doc) => {
          target.doc = updater(target.doc)
        }
      if (prop in target) return Reflect.get(target, prop)
      if (typeof prop === 'string' && (/^set[A-Z]/.test(prop) || /^on[A-Z]/.test(prop))) return noop
      return undefined
    },
  }) as unknown as FileActionContext
  window.desktop = {
    saveDocx: async (target: string, data: ArrayBuffer) => {
      await writeFile(target, new Uint8Array(data))
      return { ok: true }
    },
  } as unknown as typeof window.desktop
  return { editor, ctx, path, bytes }
}


it('native serializer and Web bridge stay clean after acknowledgement, then preserve a newer edit', async () => {
 const {editor,ctx,path}=await fixture(false)
 const outcomes:boolean[]=[]
 const host={getState:()=>({name:'a.docx',status:'idle'}),save:async (_id:string,data:Uint8Array)=>{await writeFile(path,data)}}
 const bridge=createDocsBridge(host as never,'file',{language:'en'} as never,()=>{})
 ctx.doc!.filePath='/files/file/a.docx'
 ctx.hostLifecycle={...bridge.lifecycle,afterSave(accepted){outcomes.push(accepted);bridge.lifecycle.afterSave(accepted)}}
 window.desktop={saveDocx:bridge.api.saveDocx} as never
 editor.on('update',()=>{ctx.dirtyRef.current=true;bridge.lifecycle.edited()})
 editor.commands.insertContent('Native save marker')
 expect(bridge.getState().dirty).toBe(true)
 expect(await save(ctx,false,false)).toBe(true)
 await new Promise(resolve=>setTimeout(resolve,100))
 expect(outcomes).toEqual([true])
 expect(ctx.saveIncompleteRef.current).toBe(false)
 expect(bridge.getState().dirty).toBe(false)
 const bytes=await readFile(path),zip=await JSZip.loadAsync(bytes)
 expect(await zip.file('word/document.xml')!.async('string')).toContain('Native save marker')
 editor.commands.insertContent('Newer draft')
 expect(bridge.getState().dirty).toBe(true)
 expect(await zip.file('word/document.xml')!.async('string')).not.toContain('Newer draft')
})

it('does not autosave an unaccepted streaming Word draft', async () => {
 const {editor,ctx,path}=await fixture(false)
 editor.on('update',()=>{ctx.dirtyRef.current=true})
 const draft=new DraftLanding(editor,{bullet:null,ordered:null},{kind:'after',index:0})
 try{
  draft.update('<p>UNACCEPTED_STREAM_DRAFT</p>')
  await new Promise(resolve=>setTimeout(resolve,350))
  expect(editor.getText()).toContain('UNACCEPTED_STREAM_DRAFT')
  expect(await buildDocBytes(ctx)).toBeNull()
  expect(await save(ctx,false,true)).toBe(false)
  const zip=await JSZip.loadAsync(await readFile(path))
  expect(await zip.file('word/document.xml')!.async('string')).not.toContain('UNACCEPTED_STREAM_DRAFT')
 }finally{draft.finish()}
 editor.commands.insertContent('ACCEPTED_WRITER_BODY')
 expect(await save(ctx,false,true)).toBe(true)
 const reopened=await parseDocx(new Uint8Array(await readFile(path)))
 const body=reopened.blocks.flatMap(block=>block.runs?.map(run=>run.text)??[]).join('')
 expect(body).toContain('ACCEPTED_WRITER_BODY')
 expect(body).not.toContain('UNACCEPTED_STREAM_DRAFT')
})

it.each(['document','metadata'] as const)('records content-free %s reasons without consuming a racing edit', async (kind) => {
 const {editor,ctx,path}=await fixture(false)
 const outcomes:unknown[]=[]
 ctx.pageCount=1
 if(kind==='metadata') ctx.sectionHfEdits={[`${ctx.sections.at(-1)!.lastBlockIndex}:footer`]:{text:'Total \uE000',pageNumber:false}} as never
 const host={getState:()=>({name:'a.docx',status:'idle'}),save:async (_id:string,data:Uint8Array)=>{await writeFile(path,data);if(kind==='document')editor.commands.insertContent('Newer racing draft');else ctx.pageCount=2}}
 const bridge=createDocsBridge(host as never,'file',{language:'en'} as never,()=>{})
 ctx.doc!.filePath='/files/file/a.docx'
 ctx.hostLifecycle={...bridge.lifecycle,afterSave(accepted,reasons){outcomes.push({accepted,reasons});bridge.lifecycle.afterSave(accepted,reasons)}}
 window.desktop={saveDocx:bridge.api.saveDocx} as never
 editor.on('update',()=>{ctx.dirtyRef.current=true;bridge.lifecycle.edited()})
 editor.commands.insertContent('Saved marker')
 expect(await save(ctx,false,false)).toBe(true)
 const reasons=kind==='document'?['document']:['metadata','metadata:pageCount']
 expect(outcomes).toEqual([{accepted:false,reasons}])
 expect(bridge.getState().dirty).toBe(true)
 expect(bridge.getState().nativeSaveReasons).toEqual(reasons)
 const zip=await JSZip.loadAsync(await readFile(path))
 expect(await zip.file('word/document.xml')!.async('string')).toContain('Saved marker')
 expect(await zip.file('word/document.xml')!.async('string')).not.toContain('Newer racing draft')
 if(kind==='metadata') {
   const footer=await zip.file('word/footer1.xml')!.async('string')
   expect(footer).toContain(' NUMPAGES ')
   expect(footer).toContain('<w:t>1</w:t>')
   expect(footer).not.toContain('<w:t>2</w:t>')
 }
})

 it('layout-only pageCount changes do not invalidate a body-only save', async () => {
 const {editor,ctx,path}=await fixture(false)
 ctx.pageCount=1
 const host={getState:()=>({name:'a.docx',status:'idle'}),save:async (_id:string,data:Uint8Array)=>{await writeFile(path,data);ctx.pageCount=2}}
 const bridge=createDocsBridge(host as never,'file',{language:'en'} as never,()=>{})
 ctx.doc!.filePath='/files/file/a.docx'
 ctx.hostLifecycle=bridge.lifecycle
 window.desktop={saveDocx:bridge.api.saveDocx} as never
 editor.on('update',()=>{ctx.dirtyRef.current=true;bridge.lifecycle.edited()})
 editor.commands.insertContent('Saved body marker')
 expect(await save(ctx,false,false)).toBe(true)
 expect(ctx.saveIncompleteRef.current).toBe(false)
 expect(bridge.getState().dirty).toBe(false)
 const zip=await JSZip.loadAsync(await readFile(path))
 expect(await zip.file('word/document.xml')!.async('string')).toContain('Saved body marker')
 editor.commands.insertContent('Newer body draft')
 expect(bridge.getState().dirty).toBe(true)
 expect(await zip.file('word/document.xml')!.async('string')).not.toContain('Newer body draft')
 })

it('retains the pageCount fence for a non-final section header', async () => {
 const {ctx}=await fixture(false)
 const {captureSaveMetadata}=await import('../src/renderer/save-metadata')
 ctx.pageCount=1
 ctx.sectionHfEdits={'-1:header:first':{text:'Total \uE000',pageNumber:false}} as never
 const snapshot=captureSaveMetadata(ctx)
 ctx.pageCount=2
 expect(snapshot.changed(ctx)).toBe(true)
 expect(snapshot.changedFields(ctx)).toEqual(['pageCount'])
})

it('unlink-only layout changes are not serialization changes, but new header intents still fence', async () => {
 const {ctx}=await fixture(false)
 const {captureSaveMetadata}=await import('../src/renderer/save-metadata')
 ctx.pageCount=1
 ctx.sectionHfEdits={'-1:header':{text:'Total \uE000',pageNumber:false}} as never
 ctx.hfLinks={'-1:header':true} as never
 const snapshot=captureSaveMetadata(ctx)
 ctx.pageCount=2
 expect(snapshot.changed(ctx)).toBe(false)
 ctx.hfLinks={}
 expect(snapshot.changed(ctx)).toBe(true)
 expect(snapshot.changedFields(ctx)).toEqual(['hfLinks'])
})


it('explicit analysis insert uses native tool, keeps hostile text literal and remains unsaved', async () => {
 const {editor,ctx,path}=await fixture(false)
 const {docsAnalysisEditor}=await import('../src/renderer/analysis-insert')
 let blocked=false,writes=0
 window.desktop.saveDocx=async()=>{writes++;return {ok:true}}
 const native=docsAnalysisEditor(editor,()=>ctx,()=>false,()=>{blocked=true})
 const capture=native.captureAnalysis()
 expect(await capture.apply({kind:'text',text:'<script>alert(1)</script>\n=HYPERLINK("https://example.invalid")'},()=>true)).toBe(true)
 expect(blocked).toBe(true)
 expect(writes).toBe(0)
 expect(editor.getText()).toContain('<script>alert(1)</script>')
 expect(editor.getHTML()).not.toContain('<script>')
 expect((await JSZip.loadAsync(await readFile(path))).file('word/document.xml')).not.toBeNull()
 expect(capture.matches()).toBe(false)
})

it('analysis capture refuses a later selection or revoked UI authority', async () => {
 const {editor,ctx}=await fixture(false)
 const {docsAnalysisEditor}=await import('../src/renderer/analysis-insert')
 const native=docsAnalysisEditor(editor,()=>ctx,()=>false,()=>{})
 const capture=native.captureAnalysis(),before=editor.state.doc
 expect(await capture.apply({kind:'text',text:'denied'},()=>false)).toBe(false)
 expect(editor.state.doc).toBe(before)
 editor.commands.setTextSelection(3)
 expect(await capture.apply({kind:'table',rows:[['=1+1','<img src=x>']]},()=>true)).toBe(false)
 expect(editor.state.doc).toBe(before)
})

it('analysis insertion and explicit native save return distinct verified byte receipts', async () => {
 const {editor,ctx,path}=await fixture(false)
 const {docsAnalysisEditor}=await import('../src/renderer/analysis-insert')
 const {createAnalysisDocumentTarget}=await import('../../../packages/browser-host/src/analysis-document-target')
 let revision={fileId:'file',revision:'r1',sha256:'a'.repeat(64),size:1},writes=0
 const host={getState:()=>({name:'a.docx',status:'idle',revision,lease:{leaseEpoch:1}}),save:async (_id:string,data:Uint8Array)=>{writes++;await writeFile(path,data);revision={...revision,revision:'r2',size:data.length,sha256:'b'.repeat(64)};return revision}}
 const bridge=createDocsBridge(host as never,'file',{language:'en'} as never,()=>{})
 ctx.doc!.filePath='/files/file/a.docx';ctx.hostLifecycle=bridge.lifecycle
 window.desktop={saveDocx:bridge.api.saveDocx} as never
 editor.on('update',()=>{ctx.dirtyRef.current=true;bridge.lifecycle.edited()})
 const native=docsAnalysisEditor(editor,()=>ctx,()=>false,()=>{})
 const target=createAnalysisDocumentTarget({fileId:'file',format:'docx',verifyAuthority:async()=>{},state:()=>host.getState(),editor:()=>native,receipt:()=>bridge.getReceipt(),save:async()=>await save(ctx,false,false)&&bridge.getState().nativeSaveOutcome==='accepted'})
 const applied=await target.apply(target.capture(),{kind:'table',rows:[['=1+1','<script>literal</script>']]},{artifactId:'artifact',sha256:'c'.repeat(64)},()=>true)
 expect(applied.status).toBe('applied_uncommitted');expect(writes).toBe(0)
 const receipt=await target.save(applied.applicationId,()=>true)
 expect(receipt.status).toBe('saved');expect(writes).toBe(1)
 expect(receipt.status==='saved'&&receipt.receipt.revision).toBe('r2')
 const zip=await JSZip.loadAsync(await readFile(path)),xml=await zip.file('word/document.xml')!.async('string')
 expect(xml).toContain('=1+1');expect(xml).toContain('&lt;script&gt;literal&lt;/script&gt;')
 expect(bridge.getState().dirty).toBe(false)
})

it('a queued explicit analysis save cannot write after a newer native edit',async()=>{
 const {editor,ctx,path}=await fixture(false)
 const {docsAnalysisEditor}=await import('../src/renderer/analysis-insert')
 const {createAnalysisDocumentTarget}=await import('../../../packages/browser-host/src/analysis-document-target')
 let writes=0,revision={fileId:'file',revision:'r1',sha256:'a'.repeat(64),size:1}
 const host={getState:()=>({name:'a.docx',status:'idle',revision,lease:{leaseEpoch:1}}),save:async()=>{writes++;return {...revision,revision:'r2'}}}
 const bridge=createDocsBridge(host as never,'file',{language:'en'} as never,()=>{})
 ctx.doc!.filePath='/files/file/a.docx';ctx.hostLifecycle=bridge.lifecycle;window.desktop={saveDocx:bridge.api.saveDocx} as never
 const native=docsAnalysisEditor(editor,()=>ctx,()=>false,()=>{})
 const target=createAnalysisDocumentTarget({fileId:'file',format:'docx',state:()=>host.getState(),verifyAuthority:async()=>{},editor:()=>native,receipt:()=>bridge.getReceipt(),save:check=>bridge.guardedSave(check,async()=>{
  await Promise.resolve();editor.commands.insertContent('Newer edit while queued')
  return save(ctx,false,false)
 })})
 const applied=await target.apply(target.capture(),{kind:'text',text:'Analysis report'},{artifactId:'a',sha256:'c'.repeat(64)},()=>true)
 expect((await target.save(applied.applicationId,()=>true)).status).toBe('not_confirmed')
 expect(writes).toBe(0)
 const xml=await (await JSZip.loadAsync(await readFile(path))).file('word/document.xml')!.async('string')
 expect(xml).not.toContain('Analysis report')
 expect(editor.getText()).toContain('Newer edit while queued')
})

it('AI-created DOCX reports success only after its body is actually serialized', async () => {
 const {ctx,path}=await fixture(false)
 const {applyAiDocContent}=await import('../src/renderer/file-actions')
 expect(await applyAiDocContent(ctx,{title:'Report',html:'<h1>Quarterly report</h1><p>Persisted generated body</p>'})).toBe(true)
 const zip=await JSZip.loadAsync(await readFile(path))
 expect(await zip.file('word/document.xml')!.async('string')).toContain('Persisted generated body')
})
it('AI-created DOCX reports failed or empty body saves as failures', async () => {
 const {ctx}=await fixture(false)
 const {applyAiDocContent}=await import('../src/renderer/file-actions')
 window.desktop={saveDocx:async()=>({ok:false,error:'save failed'})} as never
 expect(await applyAiDocContent(ctx,{title:'Report',html:'<p>Unsaved body</p>'})).toBe(false)
 expect(await applyAiDocContent(ctx,{title:'Report',html:''})).toBe(false)
})

it('an analysis image lands after the cursor paragraph with its provenance right below it', async () => {
 const {editor,ctx}=await fixture(false)
 const {docsAnalysisEditor}=await import('../src/renderer/analysis-insert')
 const {prepareImageContent,base64Bytes}=await import('../../../packages/browser-host/src/analysis-image')
 const RealImage=globalThis.Image
 class LoadedImage { naturalWidth=1; naturalHeight=1; onload?:()=>void; onerror?:()=>void; set src(_:string){queueMicrotask(()=>this.onload?.())} }
 ;(globalThis as {Image:unknown}).Image=LoadedImage
 try {
  editor.commands.setTextSelection(2) // inside the first paragraph
  const blocks=editor.state.doc.childCount
  const native=docsAnalysisEditor(editor,()=>ctx,()=>false,()=>{})
  const png=base64Bytes('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==')
  const content={...prepareImageContent(png,'image/png','Monthly chart'),provenance:['Source: sales v1']}
  expect(await native.captureAnalysis().apply(content,()=>true)).toBe(true)
  const doc=editor.state.doc
  expect(doc.childCount).toBe(blocks+2)
  expect(doc.child(0).textContent).toContain('Unchanged opening paragraph.')
  expect(doc.child(1).textContent).toBe('')
  expect(JSON.stringify(doc.child(1).toJSON())).toContain('Monthly chart')
  expect(doc.child(2).textContent).toContain('Source: sales v1')
  expect(doc.lastChild!.textContent).toContain('Unchanged closing paragraph.')
 } finally { (globalThis as {Image:unknown}).Image=RealImage }
})
