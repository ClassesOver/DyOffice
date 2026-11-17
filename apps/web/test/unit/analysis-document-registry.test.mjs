import test from 'node:test'
import assert from 'node:assert/strict'
import {createAnalysisDocumentRegistry} from '../../../../packages/browser-host/src/analysis-document-registry.ts'
import {literalHtml,literalRows} from '../../../../packages/browser-host/src/analysis-literal-content.ts'
test('registry replacement and unmount revoke only the owned target',()=>{const registry=createAnalysisDocumentRegistry();let a=0,b=0;const one={dispose:()=>a++},two={dispose:()=>b++};const off=registry.register(one);registry.register(two);assert.equal(a,1);off();assert.equal(registry.current(),two);registry.dispose();assert.equal(b,1);assert.equal(registry.current(),undefined)})
test('literal conversion escapes active content without interpreting formulas',()=>{assert.equal(literalHtml({kind:'text',text:'<script>x</script>\n![x](https://host)'}),'<p>&lt;script&gt;x&lt;/script&gt;</p><p>![x](https://host)</p>');assert.deepEqual(literalRows({kind:'table',rows:[['=1+1','001']]}),[['=1+1','001']]);assert.throws(()=>literalRows({kind:'png',bytes:[]}));assert.throws(()=>literalRows({kind:'text',text:'\x00'}))})

test('analysis hold blocks timer/blur saves until an explicit clean save',async()=>{
 const {createAnalysisSaveConsent}=await import('../../../../packages/browser-host/src/analysis-save-consent.ts')
 const gate=createAnalysisSaveConsent();let writes=0;gate.hold()
 const save=async()=>{writes++;return true}
 assert.equal(await gate.run(true,save,x=>x,false),false);assert.equal(writes,0)
 assert.equal(await gate.run(false,async()=>false,x=>x,false),false);assert.equal(gate.allowed(true),false)
 assert.equal(await gate.run(false,save,x=>x,false),true);assert.equal(writes,1);assert.equal(gate.allowed(true),true)
 gate.hold();await gate.run(false,async()=>{gate.hold();return true},x=>x,false)
 assert.equal(gate.allowed(true),false)
})
