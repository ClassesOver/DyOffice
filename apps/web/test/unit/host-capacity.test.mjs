import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createHash } from 'node:crypto'

// OS boundaries are mocked: these tests prove controller accounting, not systemd isolation.
const source=Buffer.from('native'),sha256=createHash('sha256').update(source).digest('hex')
let cleanup='unknown',attempts=0,prelaunch=false,removeFails=false
mock.module('node:child_process',{namedExports:{
  spawn(){attempts++;const child=new EventEmitter();for(const key of ['stdin','stdout','stderr'])child[key]=new PassThrough();child.kill=()=>true;return child},
  execFile(file,args,options,callback){
    if(file.endsWith('/ldd'))return callback(null,{stdout:'',stderr:''})
    if(args[0]==='stop')return callback(new Error('stop failed'))
    if(args[0]==='show'){
      // Initial startup has not reached /proc identity validation yet.
      if(!checked){checked=true;return callback(null,{stdout:'MainPID=42\nInvocationID=test\nControlGroup=/test\nActiveState=active'})}
      if(cleanup==='unknown')return callback(new Error('state unavailable'))
      return callback(null,{stdout:cleanup==='live'?'MainPID=42\nActiveState=active':'MainPID=0\nActiveState=inactive'})
    }
    callback(null,{stdout:'',stderr:''})
  },
}})
let checked=false
mock.module('node:fs/promises',{namedExports:{
  async open(){if(prelaunch)throw new Error('binary unavailable');return {async stat(){return {isFile:()=>true,size:source.length}},async read(buffer,offset){if(offset)return {bytesRead:0};source.copy(buffer);return {bytesRead:source.length}},async close(){}}},
  async mkdir(){},async writeFile(){},async copyFile(){},async chmod(){},async lstat(){},
  async readFile(){throw new Error('identity check failed')},
  async rm(){if(removeFails)throw new Error('remove failed')},
}})
let serial=0
async function runner(memoryMiB=512){const {createHostProcess}=await import('../../worker/src/sandbox/host-process.ts?test='+(++serial));return createHostProcess({binary:'/native',sha256,deploymentId:'00000000-0000-0000-0000-000000000000',allowedCommands:['open'],limits:{memoryMiB}})}
async function failRun(r){checked=false;return r.run(Buffer.from('input'),async()=>{})}
mock.method(process,'getuid',()=>0)
for(const state of ['unknown','live'])test(`unconfirmed ${state} cleanup retains both slot and memory reservations`,async()=>{
  cleanup=state;prelaunch=false;removeFails=false
  for(const memoryMiB of [64,1024]){
    const r=await runner(memoryMiB),slots=memoryMiB===64?2:1
    for(let i=0;i<slots;i++)await assert.rejects(()=>failRun(r),{code:'HOST_CLEANUP_FAILED'})
    assert.ok(attempts>=slots)
    const before=attempts
    await assert.rejects(()=>failRun(r),{code:'SANDBOX_BUSY'})
    assert.equal(attempts,before)
  }
})
test('confirmed stopped service releases capacity even if removal fails',async()=>{
  cleanup='stopped';prelaunch=false
  for(const removal of [false,true]){removeFails=removal;const r=await runner(1024);for(let i=0;i<3;i++)await assert.rejects(()=>failRun(r),removal?{message:'remove failed'}:{code:'HOST_BACKEND_UNAVAILABLE'})}
})
test('prelaunch failures release capacity without requiring unavailable systemd',async()=>{
  cleanup='unknown';prelaunch=true;removeFails=false
  const r=await runner(1024),before=attempts
  for(let i=0;i<3;i++)await assert.rejects(()=>failRun(r),{code:'HOST_BACKEND_UNAVAILABLE'})
  assert.equal(attempts,before)
})
