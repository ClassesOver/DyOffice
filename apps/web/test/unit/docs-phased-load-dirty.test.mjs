import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {runInNewContext} from 'node:vm'
import {JSDOM} from 'jsdom'
import {setContentPhased,cancelPhasedContent} from '../../../docs/src/renderer/phased-content.ts'
import {createDocsBridge} from '../../src/editors/docs-bridge.ts'
const app=readFileSync(new URL('../../../docs/src/renderer/App.tsx',import.meta.url),'utf8')
const actions=readFileSync(new URL('../../../docs/src/renderer/file-actions.ts',import.meta.url),'utf8')
const updateMatch=app.match(/onUpdate: \(([^)]*)\) => \{([\s\S]*?)\n    \},/);assert.ok(updateMatch)
let appendSource=actions.slice(actions.indexOf('export function appendStreamedNodes('),actions.indexOf('/** binds the phased content streamer'))
appendSource=appendSource.replace('export function','function').replace('editor: Editor, nodes: PmNode[]','editor, nodes').replace('): void',')')
const append=runInNewContext(appendSource+';appendStreamedNodes',{PHASED_APPEND:'phasedAppend',TRACK_IGNORE:'trackIgnore',TABLE_TRAILING_SKIP:'tableTrailingSkip',carryDocSeen(){}})
for(const scenario of ['clean','edit-between-chunks','edit-after-load','cancel-after-edit'])test(`real CI DOCX phased load: ${scenario}`,async t=>{
 const blocks=511
 const dom=new JSDOM('<div id="editor"></div>');for(const [k,v] of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,Event:dom.window.Event}))Object.defineProperty(globalThis,k,{configurable:true,value:v})
 globalThis.requestAnimationFrame=()=>1;globalThis.cancelAnimationFrame=()=>{};globalThis.ResizeObserver=class{observe(){}unobserve(){}disconnect(){}};globalThis.getComputedStyle=dom.window.getComputedStyle.bind(dom.window);globalThis.React=(await import('react')).default;const {createRequire}=await import('node:module');const require=createRequire(import.meta.url);for(const ext of ['css','png','svg','jpg','woff','woff2'])require.extensions['.'+ext]=()=>{};
 const {parseDocx,readSections}=await import('../../../../packages/docx-engine/src/index.ts');const {blocksToPmDoc}=await import('../../../docs/src/renderer/editor/convert.ts');const parsed=await parseDocx(new Uint8Array(readFileSync(new URL('../../../../packages/docx-engine/tests/fixtures/truths/render-sectafter-no-blank/probe.docx',import.meta.url))));const pmDoc=blocksToPmDoc(parsed.blocks,readSections(parsed));
 const {editorExtensions}=await import('../../../docs/src/renderer/editor/extensions.ts');
 const bridge=createDocsBridge({getState:()=>({name:'x.docx',status:'idle'})},'file',{language:'en'},()=>{})
 const dirtyRef={current:false},host={onDocumentEdited:()=>bridge.lifecycle.edited()}
 const onUpdate=runInNewContext('('+updateMatch[1]+')=>{'+updateMatch[2]+'}',{host,dirtyRef,PHASED_APPEND:'phasedAppend',forceRender(){}})
 const EditorCtor=require('@tiptap/core').Editor;const editor=new EditorCtor({element:document.getElementById('editor'),extensions:editorExtensions,onUpdate})
 t.after(()=>{cancelPhasedContent();editor.destroy();dom.window.close()})
 const queued=[]
 setContentPhased({setContent:doc=>editor.chain().setMeta('addToHistory',false).setMeta('phasedAppend',true).setContent(doc).run(),appendNodes:nodes=>append(editor,nodes),isDestroyed:()=>editor.isDestroyed,resetHistory(){},setLoading(){},getDirty:()=>dirtyRef.current,setDirty:v=>dirtyRef.current=v},pmDoc,cb=>queued.push(cb))
 // Actual loadFile tail resets local dirty before signaling documentOpened.
 dirtyRef.current=false;bridge.lifecycle.documentOpened()
 assert.equal(bridge.getState().dirty,false)
 queued.shift()()
 assert.equal(dirtyRef.current,false);assert.equal(bridge.getState().dirty,false)
 if(scenario==='edit-between-chunks'||scenario==='cancel-after-edit'){
   editor.commands.insertContentAt(1,'Genuine concurrent input')
   assert.equal(dirtyRef.current,true);assert.equal(bridge.getState().dirty,true)
 }
 if(scenario==='cancel-after-edit')cancelPhasedContent()
 while(queued.length)queued.shift()()
 if(scenario==='edit-after-load')editor.commands.insertContentAt(1,'Genuine concurrent input')
 t.diagnostic(JSON.stringify({blocks,localDirty:dirtyRef.current,bridgeDirty:bridge.getState().dirty,actualBlocks:editor.state.doc.childCount}))
 assert.equal(dirtyRef.current,scenario!=='clean')
 assert.equal(bridge.getState().dirty,scenario!=='clean','only real edits must mark the bridge dirty')
 if(scenario==='cancel-after-edit')assert.ok(editor.state.doc.childCount<blocks)
 else assert.equal(editor.state.doc.childCount,blocks)
 if(scenario!=='clean')assert.match(editor.state.doc.textContent,/Genuine concurrent input/)
})
