import {test} from 'node:test'
import assert from 'node:assert/strict'
import {JSDOM} from 'jsdom'
import {createDocsBridge} from '../../src/editors/docs-bridge.ts'

function fixture(t) {
  const {window}=new JSDOM('<div class="pagination-preview"><div class="pv-page pv-print-skip"></div><div class="pv-page pv-print-tail"></div></div>')
  const previous=globalThis.window
  globalThis.window=window
  const bridge=createDocsBridge({getState:()=>({name:'paper.docx',status:'idle'})},'file',{language:'en'},()=>{})
  t.after(()=>{bridge.dispose();window.close();globalThis.window=previous})
  return {window,bridge,styles:()=>[...window.document.head.querySelectorAll('style')].map(node=>node.textContent)}
}

test('Web Word keeps the document paper rule and selected pages through browser printing',async t=>{
  const {window,bridge,styles}=fixture(t)
  let duringPrint
  window.print=()=>{
    window.dispatchEvent(new window.Event('beforeprint'))
    duringPrint=styles()
  }
  const result=bridge.api.print(1,{deviceName:null},{widthTwips:15840,heightTwips:12240})
  assert.equal(duringPrint?.length,1)
  assert.match(duringPrint[0],/@page\s*\{[^}]*size:\s*11in\s+8\.5in\s*;[^}]*margin:\s*0\s*;/)
  await Promise.resolve()
  assert.deepEqual(styles(),duringPrint)
  assert.equal(window.document.querySelectorAll('.pv-print-skip, .pv-print-tail').length,2)
  window.dispatchEvent(new window.Event('afterprint'))
  assert.deepEqual(await result,{ok:true})
  assert.deepEqual(styles(),[])
})

test('Web Word drops invalid paper dimensions and removes a valid rule on print failure',async t=>{
  const {window,bridge,styles}=fixture(t)
  let duringPrint
  window.print=()=>{duringPrint=styles();throw new Error('printing unavailable')}
  assert.equal((await bridge.api.print(undefined,undefined,{widthTwips:1440,heightTwips:Infinity})).ok,false)
  assert.deepEqual(duringPrint,[])
  assert.equal((await bridge.api.print(undefined,undefined,{widthTwips:11906,heightTwips:8391})).ok,false)
  assert.equal(duringPrint.length,1)
  assert.deepEqual(styles(),[])
})
