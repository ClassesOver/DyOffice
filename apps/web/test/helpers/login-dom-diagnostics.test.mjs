import test from 'node:test'
import assert from 'node:assert/strict'
import {loginDomSnapshot,reportLoginDom} from './login-dom-diagnostics.mjs'
test('DOM snapshot only emits fixed flags and bounded counts, never values',()=>{
 const old=globalThis.document
 globalThis.document={querySelectorAll:selector=>selector==='button[type="submit"]'?[{textContent:'SECRET',disabled:true,classList:{contains:()=>true},value:'SECRET'}]:[]}
 try{const snapshot=loginDomSnapshot();assert.equal(snapshot.disabledSubmits,1);assert.equal(snapshot.loadingSubmits,1);assert.equal(snapshot.loginLabel,false);assert.ok(!JSON.stringify(snapshot).includes('SECRET'))}finally{globalThis.document=old}
})
test('report strips extra fields, invalid counts and non-boolean flags',async()=>{
 const lines=[];await reportLoginDom({evaluate:async()=>({secret:'SECRET',login:'SECRET',home:Infinity,inputs:2,loginLabel:'SECRET',reloadLabel:true})},s=>lines.push(s))
 assert.deepEqual(JSON.parse(lines[0].slice(10)),{available:true,inputs:2,reloadLabel:true})
})
test('evaluation errors are not serialized',async()=>{const lines=[];await reportLoginDom({evaluate:async()=>{throw new Error('SECRET')}},s=>lines.push(s));assert.deepEqual(lines,['login-dom {"available":false}'])})
test('unresponsive evaluation does not block original test failure indefinitely',async()=>{const lines=[];await reportLoginDom({evaluate:()=>new Promise(()=>{})},s=>lines.push(s));assert.deepEqual(lines,['login-dom {"available":false}'])})
