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

test('Web Word assigns named paper rules to selected mixed-size pages',async t=>{
  const {window,bridge,styles}=fixture(t)
  window.document.querySelector('.pagination-preview').innerHTML=
    '<div class="pv-page pv-print-skip" data-pv-page="0" style="width:576px;height:768px"></div>'+
    '<div class="pv-page" data-pv-page="1" style="width:816px;height:1056px"></div>'+
    '<div class="pv-page pv-print-tail" data-pv-page="2" style="width:1056px;height:816px"></div>'
  let css
  window.print=()=>{css=styles().join('')}
  assert.deepEqual(await bridge.api.print(1,{deviceName:null},{widthTwips:12240,heightTwips:15840}),{ok:true})
  assert.match(css,/@page docx-paper-1\s*\{[^}]*size:\s*8\.5in 11in/)
  assert.match(css,/@page docx-paper-2\s*\{[^}]*size:\s*11in 8\.5in/)
  assert.match(css,/data-pv-page="1"\][^{]*\{\s*page:\s*docx-paper-1/)
  assert.match(css,/data-pv-page="2"\][^{]*\{\s*page:\s*docx-paper-2/)
  assert.doesNotMatch(css,/data-pv-page="0"/)
  assert.deepEqual(styles(),[])
})
