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
test('accessibility diagnostics preserve fixed schema and strip arbitrary attribute data',async()=>{
 const old=globalThis.document
 const button={textContent:'登录',disabled:false,classList:{contains:()=>false},getAttribute:key=>key==='aria-labelledby'?'SECRET':null,getBoundingClientRect:()=>({x:0,y:0,width:10,height:10}),contains:()=>false}
 globalThis.document={querySelectorAll:selector=>selector==='button[type="submit"]'?[button]:selector.includes('[role="img"]')?[{}]:[],elementFromPoint:()=>button}
 try{
  const snapshot=loginDomSnapshot()
  assert.equal(snapshot.loginLabel,true);assert.equal(snapshot.loadingSubmits,0);assert.equal(snapshot.loadingIcons,1)
  assert.equal(snapshot.labelledBy,true);assert.equal(snapshot.submitHasBox,true);assert.equal(snapshot.submitCenterHit,true)
  const lines=[];await reportLoginDom({evaluate:async()=>({...snapshot,secret:'SECRET',inertSubmits:Infinity,explicitLoginLabel:'SECRET'})},s=>lines.push(s))
  assert.ok(!lines[0].includes('SECRET'));assert.ok(!lines[0].includes('Infinity'))
  const logged=JSON.parse(lines[0].slice(10));assert.equal(logged.loadingIcons,1);assert.equal(logged.submitCenterHit,true);assert.ok(!('explicitLoginLabel' in logged))
 }finally{globalThis.document=old}
})
