import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {runInNewContext} from 'node:vm'
import {transform} from 'esbuild'

// Run the shipped parent-shell guard, not a replacement copy of its behavior.
// This is a contract test, not proof that the retired DOCX editor is editable.
const source=await readFile(new URL('../src/shell/main.tsx',import.meta.url),'utf8')
const start=source.indexOf('function canCloseFrames(')
assert.ok(start>=0)
const {code}=await transform(source.slice(start,source.indexOf('\nlet token=',start)),{loader:'ts',target:'es2022'})
function fixture(allowed){
 const checks=[],discards=[]
 const frames=allowed.map((value,i)=>({dataset:{tabId:String(i)},contentWindow:{dyofficeEditorCanClose(){checks.push(i);return value},dyofficeEditorDiscard(){discards.push(i)}}}))
 const canClose=runInNewContext(code+';canCloseFrames',{document:{querySelectorAll:()=>frames}})
 return {canClose,checks,discards}
}
test('a frame close veto keeps every draft, even if another frame accepted',()=>{
 const f=fixture([true,false]);assert.equal(f.canClose(),false);assert.deepEqual(f.checks,[0,1]);assert.deepEqual(f.discards,[])
})
test('one tab close consults and discards only that tab',()=>{
 const f=fixture([false,true]);assert.equal(f.canClose('1'),true);assert.deepEqual(f.checks,[1]);assert.deepEqual(f.discards,[1])
})
test('accepted global navigation discards exactly the frames checked',()=>{
 const f=fixture([true,true]);assert.equal(f.canClose(),true);assert.deepEqual(f.checks,[0,1]);assert.deepEqual(f.discards,[0,1])
})
