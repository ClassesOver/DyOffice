import test from 'node:test'
import assert from 'node:assert/strict'
const mod=await import('../../server/src/modules/providers/budget.ts').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e})
test('budget adapter exists and rejects ordinary users before SQL',async()=>{
 assert.equal(typeof mod.createProviderBudgetService,'function')
 let queried=false
 const service=mod.createProviderBudgetService({transactions:{sessionIdleMs:1000,withPrincipalTransaction:async(_,fn)=>fn({query:async()=>{queried=true}}, {roles:['personal']})}})
 await assert.rejects(()=>service.reserve('a'.repeat(43),{turnId:'turn',entryId:'model',configRevision:1,requestDigest:'a'.repeat(64)}))
 assert.equal(queried,false)
})
