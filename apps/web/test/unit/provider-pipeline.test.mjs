import test from 'node:test'
import assert from 'node:assert/strict'
const pipeline=await import('../../server/src/modules/providers/admin-pipeline.ts').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e})
test('exports only explicit unmounted pipeline construction',()=>{
 assert.equal(typeof pipeline.createAdminProviderPipeline,'function')
})
