import {test,before,after} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {build} from 'esbuild'
import {JSDOM} from 'jsdom'
let directory,mountDocsEditor,act
before(async()=>{
 directory=await mkdtemp(fileURLToPath(new URL('./.docs-download-entry-',import.meta.url)))
 const entry=fileURLToPath(new URL('../../src/editors/native-docs.tsx',import.meta.url))
 // Keep the native host, bridge, notifications and download guards real. Only
 // the heavyweight document renderer is a slot-consuming test double; this
 // tests host actions, not Ribbon implementation or browser download transport.
 const mocks={
  App:`import React,{useEffect,useState} from 'react';export function App({host}){const [open,setOpen]=useState(false);useEffect(()=>{globalThis.__docsDownloadTest.lifecycle=host.lifecycle;if(globalThis.__docsDownloadTest.deferReady)globalThis.__docsDownloadTest.ready=(handle=globalThis.__docsDownloadTest.editor)=>host.onEditorReady(handle);else host.onEditorReady(globalThis.__docsDownloadTest.editor);host.lifecycle.documentOpened();return()=>host.onEditorReady(null)},[]);return React.createElement(React.Fragment,null,host.saveStatus,React.createElement('button',{'data-test-file-menu':true,onClick:()=>setOpen(!open)},'File'),open?React.createElement('div',{'data-test-file-actions':true},host.fileActions):null)}`,
  locale:'export const LocaleProvider=({children})=>children;export const setModuleLang=()=>{}',
  'author-name':'export const setAuthorName=()=>{}',
  ui:'export const applyAiPanelPrefs=()=>{};export const installScreenTips=()=>{};export const AssistantAvatar=()=>null',
  assistant:'export const createEditorAssistant=async(...args)=>{globalThis.__docsDownloadTest.assistantArgs=args;return globalThis.__docsDownloadTest.assistant}',
  'docs-ai-tools':'export const AGENT_TOOLS=[]',
  realtime:'export const mountEditorRealtime=()=>({notice:()=>null,dispose(){}})',
  analysis:'export const createAnalysisDocumentTarget=()=>({dispose(){}})',
 }
 await build({stdin:{contents:`export {mountDocsEditor} from ${JSON.stringify(entry)};export {act} from 'react'`,resolveDir:fileURLToPath(new URL('../../../../',import.meta.url)),loader:'tsx'},bundle:true,external:['react','react-dom/client','react/jsx-runtime'],platform:'node',format:'esm',outfile:join(directory,'entry.mjs'),jsx:'automatic',logLevel:'silent',plugins:[{name:'native-renderer-test-double',setup(b){
  b.onResolve({filter:/\.css$/},()=>({path:'css',namespace:'stub'}))
  b.onResolve({filter:/\/App$/},()=>({path:'App',namespace:'stub'}))
  b.onResolve({filter:/\/renderer\/ai\/tools$/},()=>({path:'docs-ai-tools',namespace:'stub'}))
  b.onResolve({filter:/\/i18n\/locale$/},()=>({path:'locale',namespace:'stub'}))
  b.onResolve({filter:/\/author-name$/},()=>({path:'author-name',namespace:'stub'}))
  b.onResolve({filter:/^@genoffice\/ui$/},()=>({path:'ui',namespace:'stub'}))
  b.onResolve({filter:/\/assistant(?:\.tsx)?$/},()=>({path:'assistant',namespace:'stub'}))
  b.onResolve({filter:/\/editor-realtime\.ts$/},()=>({path:'realtime',namespace:'stub'}))
  b.onResolve({filter:/\/analysis-document-target\.ts$/},()=>({path:'analysis',namespace:'stub'}))
  b.onLoad({filter:/.*/,namespace:'stub'},args=>({contents:mocks[args.path]??'',loader:'js',resolveDir:fileURLToPath(new URL('../../../../',import.meta.url))}))
 }}]})
 ;({mountDocsEditor,act}=await import(pathToFileURL(join(directory,'entry.mjs')).href))
})
after(()=>rm(directory,{recursive:true,force:true}))
async function fixture(t,{outcome='success',gate,readOnly=false,initialDirty=true,currentHead=true,deferReady=false,draftAuthority,serialize=async()=>null,assistant}={}){
 const dom=new JSDOM('<div id="editor"></div>',{url:'https://office.example/'})
 dom.window.document.getElementById('editor').inert=false
 const old={};for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,IS_REACT_ACT_ENVIRONMENT:true})){
  old[key]=Object.getOwnPropertyDescriptor(globalThis,key);Object.defineProperty(globalThis,key,{configurable:true,writable:true,value})
 }
 const fileId='11111111-1111-4111-8111-111111111111',before={fileId,revision:'22222222-2222-4222-8222-222222222222',sha256:'a'.repeat(64),size:1},after={...before,revision:'33333333-3333-4333-8333-333333333333',sha256:'b'.repeat(64),size:2}
 let state={name:'a.docx',status:outcome==='unknown-before'?'unknown':'idle',revision:before,lease:readOnly?null:{leaseEpoch:1}},saves=0,reconciles=0,dirty=initialDirty
 const downloads=[];dom.window.HTMLAnchorElement.prototype.click=function(){downloads.push(this.href)}
 const host={isCurrentRevision:async()=>currentHead,takeoverLease:async()=>{state.lease={leaseEpoch:2};state.status='idle'},releaseLease:async()=>{state.lease=null},getEditorId:()=>fileId,subscribe:()=>()=>{},open:async()=>({format:'docx'}),getPreferences:async()=>({language:'en',theme:'light',showAssistant:false}),getState:()=>state,acquireLease:async()=>{if(readOnly)throw Error('held elsewhere');return {leaseEpoch:1}},startRenewal:()=>()=>{},save:async()=>{saves++;await gate?.promise;if(outcome==='unknown-after'){state.status='unknown';throw Error('lost acknowledgement')}state.revision=after;return {...after}},reconcile:async()=>{reconciles++;throw Error('unexpected reconcile')}}
 const control={assistant,deferReady,editor:{getSelection:()=>null,serialize,isDirty:()=>dirty,async save(){await control.lifecycle.beforeSave();const result=await dom.window.desktop.saveDocx(`/files/${fileId}/a.docx`,new ArrayBuffer(2));dirty=outcome==='late-edit'||!result.ok;control.lifecycle.afterSave(result.ok&&outcome!=='late-edit');return result.ok}}}
 globalThis.__docsDownloadTest=control
 let mounted;await act(async()=>{mounted=await mountDocsEditor(host,dom.window.document.getElementById('editor'),fileId,draftAuthority)})
 assert.equal(dom.window.document.querySelector('.dyoffice-docs-save-download'),null,'host actions are hidden until the File slot is opened')
 await act(async()=>{dom.window.document.querySelector('[data-test-file-menu]').click()})
 assert.ok(dom.window.document.querySelector('.dyoffice-docs-save-download'),'renderer must expose the real host action')
 let disposed=false
 const dispose=async()=>{if(!disposed){disposed=true;await act(async()=>mounted.unload())}}
 t.after(async()=>{await dispose();dom.window.close();delete globalThis.__docsDownloadTest;for(const key of Object.keys(old)){if(old[key])Object.defineProperty(globalThis,key,old[key]);else delete globalThis[key]}})
 return {button:dom.window.document.querySelector('.dyoffice-docs-save-download'),element:dom.window.document.getElementById('editor'),downloads,before,after,dispose,tryClose:()=>mounted.dispose(),counts:()=>({saves,reconciles}),state:()=>state}
}
for(const outcome of ['success','late-edit','unknown-before','unknown-after'])test(`actual Word host download entry: ${outcome}`,async t=>{
 const f=await fixture(t,{outcome})
 const historical=f.element.querySelector('a[download]')
 assert.equal(historical.textContent,'Download saved version')
 assert.deepEqual(Object.fromEntries(new URL(historical.href).searchParams),{revision:f.before.revision,download:'1'})
 assert.match(f.button.title,/may create a new version/)
 assert.equal(f.button.disabled,outcome==='unknown-before')
 await act(async()=>{f.button.click()})
 if(outcome==='success'){
  assert.equal(f.downloads.length,1)
  assert.deepEqual(Object.fromEntries(new URL(f.downloads[0]).searchParams),{revision:f.after.revision,download:'1'})
 }
 else assert.deepEqual(f.downloads,[])
 assert.equal(f.counts().saves,outcome==='unknown-before'?0:1);assert.equal(f.counts().reconciles,0)
})
for(const dispose of [false,true])test(`Word host blocks duplicate download clicks${dispose?' and navigation suppresses the result':''}`,async t=>{
 let release;const gate={promise:new Promise(r=>{release=r})},f=await fixture(t,{gate})
 await act(async()=>{f.button.click();f.button.click()})
 assert.equal(f.counts().saves,1);assert.equal(f.downloads.length,0)
 if(dispose){assert.equal(await f.tryClose(),false);await f.dispose()}
 await act(async()=>{release();await gate.promise})
 assert.equal(f.downloads.length,dispose?0:1)
})

for(const scenario of ['stale','dirty','clean'])test(`actual Word takeover entry: ${scenario}`,async t=>{
 const f=await fixture(t,{readOnly:true,initialDirty:scenario==='dirty',currentHead:scenario!=='stale'})
 const takeover=[...f.element.querySelectorAll('button')].find(b=>b.textContent==='Take over editing');assert.ok(takeover)
 await act(async()=>{takeover.click()})
 assert.equal(f.element.inert,false)
 if(scenario==='clean'){assert.equal(f.state().lease.leaseEpoch,2);assert.equal(f.element.querySelector('[role=alert]'),null)}
 else{assert.equal(f.state().lease,null);assert.match(f.element.querySelector('[role=alert]').textContent,scenario==='stale'?/newer version.*close and reopen/:/Unsaved changes are preserved/);assert.equal(f.state().revision.revision,f.before.revision)}
 assert.deepEqual(f.counts(),{saves:0,reconciles:0})
})

 test('clean read-only Word becomes takeover-ready after delayed renderer registration',async t=>{
 const f=await fixture(t,{readOnly:true,initialDirty:false,deferReady:true})
 const button=()=>[...f.element.querySelectorAll('button')].find(b=>b.textContent==='Take over editing')
 assert.equal(button().disabled,true)
 assert.equal(button().getAttribute('data-takeover-blockers'),'no-handle')
 await act(async()=>globalThis.__docsDownloadTest.ready())
 assert.equal(button().disabled,false,'registration must refresh host action readiness without a lease or document event')
 assert.equal(button().getAttribute('data-takeover-blockers'),'')
 await act(async()=>button().click())
 assert.equal(f.state().lease.leaseEpoch,2)
 assert.deepEqual(f.counts(),{saves:0,reconciles:0})
 })

test('Word renderer unregister and repeated registration preserve takeover readiness without lease changes',async t=>{
 const f=await fixture(t,{readOnly:true,initialDirty:false,deferReady:true})
 const ready=globalThis.__docsDownloadTest.ready
 const button=()=>[...f.element.querySelectorAll('button')].find(b=>b.textContent==='Take over editing')
 await act(async()=>ready());assert.equal(button().disabled,false)
 await act(async()=>ready());assert.equal(button().disabled,false)
 await act(async()=>ready(null));assert.equal(button().disabled,true)
 await act(async()=>ready(null));assert.equal(button().disabled,true)
 assert.equal(f.state().lease,null)
 await act(async()=>ready());assert.equal(button().disabled,false)
 await f.dispose()
 await act(async()=>ready());assert.equal(f.element.childElementCount,0)
 assert.equal(f.state().lease,null);assert.deepEqual(f.counts(),{saves:0,reconciles:0})
})

test('real File menu exposes explicit draft copy while dirty/unknown; no server save or recovery',async t=>{
 const f=await fixture(t,{outcome:'unknown-before',draftAuthority:{current:()=>true,verify:async()=>true},serialize:async()=>new Uint8Array([80,75,1])})
 const button=f.element.querySelector('.dyoffice-docs-draft-copy')
 assert.ok(button);assert.equal(button.disabled,false);assert.deepEqual(f.downloads,[])
 await act(async()=>button.click())
 assert.equal(f.downloads.length,1);assert.ok(f.downloads[0].startsWith('blob:'))
 assert.equal(f.state().status,'unknown');assert.deepEqual(f.counts(),{saves:0,reconciles:0})
 assert.equal(await f.tryClose(),false)
})
test('real File menu denies draft copy without a bound session capability',async t=>{
 const f=await fixture(t)
 const button=f.element.querySelector('.dyoffice-docs-draft-copy')
 assert.equal(button.disabled,true);await act(async()=>button.click());assert.deepEqual(f.downloads,[])
})
test('real File menu suppresses late draft when session ends during serialize',async t=>{
 let resolve,active=true,started=false
 const wait=new Promise(r=>resolve=r)
 const f=await fixture(t,{draftAuthority:{current:()=>active,verify:async()=>active},serialize:async()=>{started=true;await wait;return new Uint8Array([80,75])}})
 await act(async()=>f.element.querySelector('.dyoffice-docs-draft-copy').click())
 assert.equal(started,true);active=false
 await act(async()=>resolve())
 assert.deepEqual(f.downloads,[]);assert.deepEqual(f.counts(),{saves:0,reconciles:0})
})

test('real File menu drops pending snapshot across detach/rebind of the same editor',async t=>{
 let resolve
 const wait=new Promise(r=>resolve=r)
 const f=await fixture(t,{deferReady:true,draftAuthority:{current:()=>true,verify:async()=>true},serialize:async()=>{await wait;return new Uint8Array([80,75])}})
 const control=globalThis.__docsDownloadTest
 await act(async()=>control.ready())
 await act(async()=>f.element.querySelector('.dyoffice-docs-draft-copy').click())
 await act(async()=>{control.ready(null);control.ready()})
 await act(async()=>resolve())
 assert.deepEqual(f.downloads,[]);assert.deepEqual(f.counts(),{saves:0,reconciles:0})
})

test('Word entry injects the existing assistant bound request into its knowledge bridge',async t=>{
 const reference='/files/11111111-1111-4111-8111-111111111111/revisions/22222222-2222-4222-8222-222222222222'
 const requests=[],corpus=[{path:reference+'/source.docx',name:'source.docx',ext:'docx',folder:'',folderPath:'',sizeBytes:1}]
 const assistant={available:false,api:{},documents:{register:()=>()=>{}},request:async path=>{requests.push(path);return corpus},dispose(){}}
 const f=await fixture(t,{assistant})
 assert.deepEqual(await window.desktop.kbList(),[{...corpus[0],path:reference}])
 assert.deepEqual(requests,['/api/v1/knowledge/files'])
 await f.dispose();await assert.rejects(window.desktop.kbList())
})

test('Word entry offers knowledge tools in its actual native assistant inventory',async t=>{
 await fixture(t)
 const args=globalThis.__docsDownloadTest.assistantArgs
 assert.equal(args[2],'docx')
 assert.equal(args[3] instanceof Set,true)
 assert.equal(args[3].has('read_attachment'),true)
 assert.equal(args[3].has('read_knowledge_file'),true)
 assert.equal(args[3].has('search_knowledge_base'),true)
 assert.equal(args[3].has('not_a_native_tool'),false)
})
