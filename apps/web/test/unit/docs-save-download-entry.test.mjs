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
 const mocks={
  App:`import React,{useEffect} from 'react';export function App({host}){useEffect(()=>{globalThis.__docsDownloadTest.lifecycle=host.lifecycle;host.onEditorReady(globalThis.__docsDownloadTest.editor);host.lifecycle.documentOpened();return()=>host.onEditorReady(null)},[]);return null}`,
  locale:'export const LocaleProvider=({children})=>children;export const setModuleLang=()=>{}',
  'author-name':'export const setAuthorName=()=>{}',
  ui:'export const applyAiPanelPrefs=()=>{};export const installScreenTips=()=>{}',
  assistant:'export const createEditorAssistant=async()=>undefined',
  realtime:'export const mountEditorRealtime=()=>({notice:()=>null,dispose(){}})',
  analysis:'export const createAnalysisDocumentTarget=()=>({dispose(){}})',
 }
 await build({stdin:{contents:`export {mountDocsEditor} from ${JSON.stringify(entry)};export {act} from 'react'`,resolveDir:fileURLToPath(new URL('../../../../',import.meta.url)),loader:'tsx'},bundle:true,external:['react','react-dom/client','react/jsx-runtime'],platform:'node',format:'esm',outfile:join(directory,'entry.mjs'),jsx:'automatic',logLevel:'silent',plugins:[{name:'native-renderer-test-double',setup(b){
  b.onResolve({filter:/\.css$/},()=>({path:'css',namespace:'stub'}))
  b.onResolve({filter:/\/App$/},()=>({path:'App',namespace:'stub'}))
  b.onResolve({filter:/\/i18n\/locale$/},()=>({path:'locale',namespace:'stub'}))
  b.onResolve({filter:/\/author-name$/},()=>({path:'author-name',namespace:'stub'}))
  b.onResolve({filter:/^@genoffice\/ui$/},()=>({path:'ui',namespace:'stub'}))
  b.onResolve({filter:/\/assistant\.tsx$/},()=>({path:'assistant',namespace:'stub'}))
  b.onResolve({filter:/\/editor-realtime\.ts$/},()=>({path:'realtime',namespace:'stub'}))
  b.onResolve({filter:/\/analysis-document-target\.ts$/},()=>({path:'analysis',namespace:'stub'}))
  b.onLoad({filter:/.*/,namespace:'stub'},args=>({contents:mocks[args.path]??'',loader:'js',resolveDir:fileURLToPath(new URL('../../../../',import.meta.url))}))
 }}]})
 ;({mountDocsEditor,act}=await import(pathToFileURL(join(directory,'entry.mjs')).href))
})
after(()=>rm(directory,{recursive:true,force:true}))
async function fixture(t,{outcome='success',gate}={}){
 const dom=new JSDOM('<div id="editor"></div>',{url:'https://office.example/'})
 const old={};for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,IS_REACT_ACT_ENVIRONMENT:true})){
  old[key]=Object.getOwnPropertyDescriptor(globalThis,key);Object.defineProperty(globalThis,key,{configurable:true,writable:true,value})
 }
 const fileId='11111111-1111-4111-8111-111111111111',before={fileId,revision:'22222222-2222-4222-8222-222222222222',sha256:'a'.repeat(64),size:1},after={...before,revision:'33333333-3333-4333-8333-333333333333',sha256:'b'.repeat(64),size:2}
 let state={name:'a.docx',status:outcome==='unknown-before'?'unknown':'idle',revision:before,lease:{leaseEpoch:1}},saves=0,reconciles=0,dirty=true
 const downloads=[];dom.window.HTMLAnchorElement.prototype.click=function(){downloads.push(this.href)}
 const host={releaseLease:async()=>{},getEditorId:()=>fileId,subscribe:()=>()=>{},open:async()=>({format:'docx'}),getPreferences:async()=>({language:'en',theme:'light',showAssistant:false}),getState:()=>state,acquireLease:async()=>({leaseEpoch:1}),startRenewal:()=>()=>{},save:async()=>{saves++;await gate?.promise;if(outcome==='unknown-after'){state.status='unknown';throw Error('lost acknowledgement')}state.revision=after;return {...after}},reconcile:async()=>{reconciles++;throw Error('unexpected reconcile')}}
 const control={editor:{getSelection:()=>null,serialize:async()=>null,isDirty:()=>dirty,async save(){await control.lifecycle.beforeSave();const result=await dom.window.desktop.saveDocx(`/files/${fileId}/a.docx`,new ArrayBuffer(2));dirty=outcome==='late-edit'||!result.ok;control.lifecycle.afterSave(result.ok&&outcome!=='late-edit');return result.ok}}}
 globalThis.__docsDownloadTest=control
 let mounted;await act(async()=>{mounted=await mountDocsEditor(host,dom.window.document.getElementById('editor'),fileId)})
 let disposed=false
 const dispose=async()=>{if(!disposed){disposed=true;await act(async()=>mounted.unload())}}
 t.after(async()=>{await dispose();dom.window.close();delete globalThis.__docsDownloadTest;for(const key of Object.keys(old)){if(old[key])Object.defineProperty(globalThis,key,old[key]);else delete globalThis[key]}})
 return {button:dom.window.document.querySelector('.dyoffice-docs-save-download'),element:dom.window.document.getElementById('editor'),downloads,before,after,dispose,tryClose:()=>mounted.dispose(),counts:()=>({saves,reconciles}),state:()=>state}
}
for(const outcome of ['success','late-edit','unknown-before','unknown-after'])test(`actual Word host download entry: ${outcome}`,async t=>{
 const f=await fixture(t,{outcome})
 const historical=f.element.querySelector('a[download]')
 assert.equal(historical.textContent,'Download saved version');assert.ok(historical.href.endsWith(f.before.revision))
 assert.match(f.element.textContent,/may create a new version/)
 await act(async()=>{f.button.click()})
 if(outcome==='success'){assert.equal(f.downloads.length,1);assert.ok(f.downloads[0].endsWith(f.after.revision))}
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
