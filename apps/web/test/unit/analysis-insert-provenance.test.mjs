import test from 'node:test'
import assert from 'node:assert/strict'
import {withAnalysisProvenance} from '../../../../packages/browser-host/src/analysis-insert-provenance.ts'
const artifact={artifactId:'file',sha256:'a'.repeat(64),inputResultIds:['input']}
const receipt={commandId:'cmd',artifacts:[artifact],inputs:[{resultId:'input',sourceId:'metrics',sourceVersion:2,queryHash:'b'.repeat(64),sha256:'c'.repeat(64),rowCount:4,truncated:true}],limitations:['<script>model limitation</script>']}
test('inserted literal text carries truncation, reference and unknown units/timezone without claiming verified conclusions',()=>{
 const v=withAnalysisProvenance({kind:'text',text:'Total: 900'},receipt,artifact)
 assert.equal(v.kind,'text');assert.match(v.text,/Total: 900/);assert.match(v.text,/TRUNCATED/);assert.match(v.text,/not.*full dataset/);assert.match(v.text,/metrics/);assert.match(v.text,/Units and timezone: not recorded/);assert.match(v.text,/Unverified analysis/);assert.match(v.text,/Model-supplied limitation: <script>/)
})
test('table notes stay literal cells and do not remove any data row',()=>{
 const v=withAnalysisProvenance({kind:'table',rows:[['=1+1','<img>']]},receipt,artifact)
 assert.deepEqual(v.rows[0],['=1+1','<img>']);assert.ok(v.rows.some(row=>row.some(cell=>cell.includes('TRUNCATED'))));assert.ok(v.rows.every(row=>row.every(cell=>typeof cell==='string')))
})
test('missing references, changed artifact identity and total over-limit content reject whole insertion',()=>{
 assert.throws(()=>withAnalysisProvenance({kind:'text',text:'x'},{...receipt,inputs:[]},artifact))
 assert.throws(()=>withAnalysisProvenance({kind:'text',text:'x'},receipt,{...artifact,sha256:'d'.repeat(64)}))
 assert.throws(()=>withAnalysisProvenance({kind:'text',text:'x'.repeat(65536)},receipt,artifact))
})
test('server-projected frozen schema units and timezone are preserved as literal provenance',()=>{
 const r={...receipt,inputs:[{...receipt.inputs[0],timezone:'Asia/Shanghai',schema:[{name:'revenue',type:'number',unit:'CNY'},{name:'note',type:'string'}]}]}
 const value=withAnalysisProvenance({kind:'text',text:'Generated estimate'},r,artifact)
 assert.match(value.text,/Input timezone: Asia\/Shanghai/);assert.match(value.text,/revenue; type: number; unit: CNY/);assert.match(value.text,/note; type: string; unit: not specified/);assert.doesNotMatch(value.text,/Units and timezone: not recorded/)
})
