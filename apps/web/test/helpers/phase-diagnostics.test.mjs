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

// EventEmitter models only Playwright's public request event boundary; the real
// observer and sanitizing reporter are exercised, not a mock diagnostic sink.
import { EventEmitter } from 'node:events'
import * as diagnostics from './phase-diagnostics.mjs'
test('first request lifecycle is exact identity, fixed output and disposed',()=>{
 const page=new EventEmitter(),lines=[],controller=new AbortController()
 const d=phaseDiagnostics(controller.signal,line=>lines.push(line))
 assert.equal(typeof diagnostics.observeFirstRequest,'function')
 const observer=diagnostics.observeFirstRequest(page,d)
 const secret='secret-token-document-body'
 const first={failure:()=>({errorText:secret}),url(){throw new Error('must not inspect URL')}}
 const other={failure(){throw new Error('must not inspect other request')}}
 page.emit('requestfinished',undefined)
 observer.watch(first);observer.watch(other)
 page.emit('requestfinished',other);page.emit('requestfailed',other)
 page.emit('requestfinished',first);page.emit('requestfailed',first)
 observer.dispose();page.emit('requestfinished',first)
 controller.abort()
 assert.deepEqual(JSON.parse(lines[0].slice(14)).counts,{'first-request-finished':1,'first-request-failed':1,'first-failure-other':1})
 assert.equal(lines[0].includes(secret),false)
 assert.equal(page.listenerCount('requestfinished'),0)
 assert.equal(page.listenerCount('requestfailed'),0)
})
test('failure categories never stringify unknown values or throw into browser events',()=>{
 for(const [failure,key] of [
  [()=>({errorText:'net::ERR_ABORTED'}),'first-failure-aborted'],
  [()=>({errorText:{toString(){throw new Error('secret')}}}),'first-failure-unavailable'],
  [()=>null,'first-failure-unavailable'],
  [()=>{throw new Error('secret')},'first-failure-unavailable'],
 ]){
  const page=new EventEmitter(),lines=[],d=phaseDiagnostics(new AbortController().signal,line=>lines.push(line))
  assert.equal(typeof diagnostics.observeFirstRequest,'function')
  const observer=diagnostics.observeFirstRequest(page,d),request={failure}
  observer.watch(request);assert.doesNotThrow(()=>page.emit('requestfailed',request));d.report();observer.dispose()
  assert.deepEqual(JSON.parse(lines[0].slice(14)).counts,{'first-request-failed':1,[key]:1})
  assert.equal(lines[0].includes('secret'),false)
 }
})
