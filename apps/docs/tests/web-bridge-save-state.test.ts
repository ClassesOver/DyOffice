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
import { noteDocumentSwapped, save, type FileActionContext } from '../src/renderer/file-actions'
import { EMPTY_HF_VARIANTS } from '../src/renderer/doc-state'

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

it.each(['document','metadata'] as const)('records content-free %s reasons without consuming a racing edit', async (kind) => {
 const {editor,ctx,path}=await fixture(false)
 const outcomes:unknown[]=[]
 ctx.pageCount=1
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
})
