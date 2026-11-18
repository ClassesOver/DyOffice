import test from 'node:test'
import assert from 'node:assert/strict'
import {createWebHomeBridge} from '../../src/shell/web-home-bridge.ts'
test('recents preserve real server identities, filtering and pagination',async()=>{
 const bridge=createWebHomeBridge({request:async()=>[{id:'1',name:'one.docx',format:'docx',size:12,updatedAt:'2026-01-01'}],open:async()=>{},changed:()=>{},unsupported:()=>{}})
 const result=await bridge.recents({limit:0});assert.equal(result.total,1);assert.deepEqual(result.entries,[])
 assert.equal((await bridge.recents()).entries[0].path,'1')
 assert.equal((await bridge.recents({ext:'pdf'})).total,0)
})
test('unsupported desktop mutation rejects instead of pretending success',async()=>{
 const notices=[];const bridge=createWebHomeBridge({request:async()=>[],open:async()=>{},changed:()=>{},unsupported:m=>notices.push(m)})
 await assert.rejects(bridge.deleteFiles(['1']),/当前网页版不支持此操作/);assert.equal(notices.length,1)
})
test('session stars and filename search operate on real returned records without claiming persistence',async()=>{
 let changed=0;const bridge=createWebHomeBridge({request:async()=>[{id:'1',name:'one.docx',format:'docx',size:12,updatedAt:'2026-01-01'},{id:'2',name:'two.pdf',format:'pdf',size:8,updatedAt:'2026-01-01'}],open:async()=>{},changed:()=>changed++,unsupported:()=>{}})
 await bridge.toggleStar('1');assert.equal((await bridge.starred()).entries[0].path,'1');assert.equal(changed,1)
 assert.equal((await bridge.searchFiles({q:'ONE'})).hits[0].path,'1')
 await bridge.toggleStar('1');assert.equal((await bridge.starred()).total,0)
})
