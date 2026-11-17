import {test} from 'node:test'
import assert from 'node:assert/strict'
import {JSDOM} from 'jsdom'
import {installInputDiagnostics, withInputDiagnostics} from '../helpers/input-diagnostics.mjs'
function fixture(t) {
  const dom = new JSDOM('<div class="tiptap doc-page" contenteditable="true">CONFIDENTIAL_DOCUMENT</div>', {runScripts:'outside-only'})
  t.after(() => dom.window.close())
  const run = fn => dom.window.eval(`(${fn.toString()})()`)
  const page = {addInitScript: async fn => run(fn), evaluate: async fn => run(fn)}
  return {dom,run,page}
}
test('bounded input trace contains positions/categories only, not text or arbitrary event strings', t => {
  const {dom,run} = fixture(t), w = dom.window
  run(installInputDiagnostics)
  const root = w.document.querySelector('.tiptap'), selection = w.document.getSelection()
  selection.setBaseAndExtent(root.firstChild, 1, root.firstChild, 4)
  root.editor = {state:{selection:{from:2,to:5,anchor:2,head:5,secret:'PRIVATE_PM_DOCUMENT'}}}
  for(let i=0;i<140;i++)w.document.dispatchEvent(new w.KeyboardEvent('keydown',{key:'SECRET_KEY',ctrlKey:true}))
  w.document.dispatchEvent(new w.InputEvent('beforeinput',{inputType:'PRIVATE_TYPE',data:'PRIVATE_INPUT'}))
  w.document.dispatchEvent(new w.InputEvent('input',{inputType:'insertText',data:'PRIVATE_INPUT'}))
  w.document.dispatchEvent(new w.Event('selectionchange'))
  w.document.dispatchEvent(new w.Event('genoffice:phased-content-settled'))
  const report = w.__dyofficeInputDiagnostics.stop(), serialized = JSON.stringify(report)
  assert.equal(report.events.length,128);assert.ok(report.total>128)
  for(const secret of ['CONFIDENTIAL_DOCUMENT','SECRET_KEY','PRIVATE_TYPE','PRIVATE_INPUT','PRIVATE_PM_DOCUMENT']) assert.equal(serialized.includes(secret),false)
  assert.equal(report.events.at(-1).kind,'phased-settled')
  assert.deepEqual(JSON.parse(JSON.stringify(report.events.at(-1).pm)),{from:2,to:5,anchor:2,head:5})
  assert.equal(report.events.at(-1).selection.anchor.offset,1)
  assert.deepEqual(Array.from(report.events.at(-1).selection.anchor.path),[0])
  assert.equal(report.events.at(-3).dataLength,'PRIVATE_INPUT'.length)
  assert.equal(report.events.at(-4).inputType,'other')
  w.document.dispatchEvent(new w.Event('selectionchange'))
  assert.equal(w.__dyofficeInputDiagnostics.stop().total,report.total,'stop removes listeners')
})
test('successful action does not emit diagnostics', async t => {
  const {page,dom}=fixture(t), output=[]
  assert.equal(await withInputDiagnostics(page,async()=>42,v=>output.push(v)),42)
  assert.deepEqual(output,[])
  assert.equal(dom.window.__dyofficeInputDiagnostics,undefined)
})
test('failure emits only the bounded report and rethrows the identical error', async t => {
  const {page}=fixture(t), output=[], error=new Error('PRIVATE_FAILURE_TEXT')
  await assert.rejects(withInputDiagnostics(page,async()=>{throw error},v=>output.push(v)),e=>e===error)
  assert.equal(output.length,1)
  assert.equal(output[0].includes('PRIVATE_FAILURE_TEXT'),false)
  assert.equal(output[0].includes('CONFIDENTIAL_DOCUMENT'),false)
  assert.ok(JSON.parse(output[0]).inputDiagnostics.events.length<=128)
})
test('a closed page reports no evaluation error or document content', async()=>{
  const output=[],error=new Error('PRIVATE_ORIGINAL')
  const page={addInitScript:async()=>{},evaluate:async()=>{throw Error('PRIVATE_EVALUATION')}}
  await assert.rejects(withInputDiagnostics(page,async()=>{throw error},v=>output.push(v)),e=>e===error)
  assert.equal(output[0],'{"inputDiagnostics":{"unavailable":true}}')
})
