import test from 'node:test'
import assert from 'node:assert/strict'
import {phaseDiagnostics} from './phase-diagnostics.mjs'

test('timeout reports cached phase synchronously and only once',()=>{
 const controller=new AbortController(),lines=[]
 const d=phaseDiagnostics(controller.signal,line=>lines.push(line))
 d.stage('first-commit-wait');d.count('fetch-started');controller.abort();d.report()
 assert.equal(lines.length,1)
 assert.deepEqual(JSON.parse(lines[0].slice('browser-phase '.length)),{stage:'first-commit-wait',counts:{'fetch-started':1},statuses:[]})
})
test('unknown strings, objects, identifiers and arbitrary statuses never enter output',()=>{
 const controller=new AbortController(),lines=[]
 const d=phaseDiagnostics(controller.signal,line=>lines.push(line))
 const secret='TOKEN-document-body-username'
 d.stage(secret);d.count(secret);d.status(secret);d.status({secret});d.status(700);d.status(200)
 d.report();assert.equal(lines.length,1);assert.equal(lines[0].includes(secret),false)
 assert.deepEqual(JSON.parse(lines[0].slice(14)),{stage:'fixture',counts:{},statuses:[200]})
})
test('success and disposed hooks remain silent; reporting cannot mask an error',()=>{
 const lines=[],a=new AbortController(),b=new AbortController()
 const success=phaseDiagnostics(a.signal,line=>lines.push(line));success.stage('complete');a.abort()
 const disposed=phaseDiagnostics(b.signal,line=>lines.push(line));disposed.dispose();b.abort()
 assert.deepEqual(lines,[])
 const bad=phaseDiagnostics(new AbortController().signal,()=>{throw new Error('logger')})
 assert.doesNotThrow(()=>bad.report())
})
test('status and count output is bounded',()=>{
 const lines=[],d=phaseDiagnostics(new AbortController().signal,line=>lines.push(line))
 for(let i=0;i<12000;i++){d.count('request');d.status(200)}
 d.report();const value=JSON.parse(lines[0].slice(14))
 assert.equal(value.counts.request,10000);assert.equal(value.statuses.length,32)
})
test('immediate observer does not swallow the original response rejection',async()=>{
 const error=new Error('original'),lines=[]
 const d=phaseDiagnostics(new AbortController().signal,line=>lines.push(line));d.stage('login-click')
 const response=Promise.reject(error)
 void response.catch(()=>d.report())
 await new Promise(resolve=>setImmediate(resolve))
 await assert.rejects(response,actual=>actual===error)
 assert.equal(lines.length,1)
})

test('each post-release wait has a distinct synchronous timeout marker',()=>{
 for(const stage of ['first-response-wait','first-response-finished','native-incomplete','native-dirty']){
  const controller=new AbortController(),lines=[]
  const d=phaseDiagnostics(controller.signal,line=>lines.push(line))
  d.stage('release');d.stage(stage);controller.abort()
  assert.equal(lines.length,1)
  assert.equal(JSON.parse(lines[0].slice('browser-phase '.length)).stage,stage)
 }
})
