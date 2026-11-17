import {test} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {spawn} from 'node:child_process'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {frameCollector,requestHeader,resultHeader,encodeFrame,commandSnapshot,tuple,sha} from '../helpers/pdf-candidate-wire.mjs'
import {preparePdfCandidate} from '../../scripts/prepare-pdf-runtime-candidate.mjs'
const command={version:1,action:'rotatePages',operations:[{page:1,degrees:90}]},bytes=Buffer.from('fixture-only')
function binding(){return {requestId:randomUUID(),contextId:randomUUID(),contextVersion:1,jobId:randomUUID(),jobEpoch:1,attempt:1,fileId:randomUUID(),baseRevision:randomUUID(),leaseEpoch:1,inputSha256:sha(bytes),inputSize:bytes.length,commandDigest:commandSnapshot(command).digest}}
test('wire limits before buffering, exact EOF and strict digest data prevent permissive framing',()=>{
 const b=binding(),header=requestHeader({version:1,kind:'pdf-fixture-request',binding:b,command}),frame=Buffer.concat(encodeFrame(header,bytes))
 const collector=frameCollector(requestHeader,h=>h.binding.inputSize);for(const byte of frame)collector.push(Buffer.from([byte]));assert.deepEqual(collector.finish().bytes,bytes)
 for(const malformed of [frame.subarray(0,-1),Buffer.concat([frame,Buffer.from([0])]),Buffer.concat([frame,frame])]){const c=frameCollector(requestHeader,h=>h.binding.inputSize);assert.throws(()=>{c.push(malformed);c.finish()})}
 const oversized=Buffer.alloc(4);oversized.writeUInt32BE(16385);assert.throws(()=>frameCollector(requestHeader,h=>h.binding.inputSize).push(oversized))
 let coerced=false;const digest={toString(){coerced=true;return 'a'.repeat(64)}}
 assert.throws(()=>tuple({...b,inputSha256:digest}));assert.throws(()=>tuple({...b,commandDigest:digest}));assert.throws(()=>resultHeader({version:1,kind:'pdf-fixture-result',binding:b,outputSha256:digest,outputSize:1}));assert.equal(coerced,false)
 assert.throws(()=>tuple({...b,inputSize:32*1024*1024+1}))
 const badJson=Buffer.from('{"version":1,');const prefix=Buffer.alloc(4);prefix.writeUInt32BE(badJson.length);assert.throws(()=>frameCollector(requestHeader,h=>h.binding.inputSize).push(Buffer.concat([prefix,badJson])))
})
test('standalone fixed child denies absent gates and has its own partial-input deadline',async t=>{
 const parent=await mkdtemp(join(tmpdir(),'pdf-child-'));t.after(()=>rm(parent,{recursive:true,force:true}))
 const candidate=await preparePdfCandidate({sourceRoot:fileURLToPath(new URL('../../../..',import.meta.url)),outputParent:parent})
 async function child(env,partial){return new Promise((resolve,reject)=>{
  const c=spawn(process.execPath,[join(candidate.directory,'session.cjs')],{env,stdio:['pipe','pipe','pipe']}),timer=setTimeout(()=>{c.kill('SIGKILL');reject(Error('child own deadline missing'))},6500)
  let output=0,stderr=0;c.stdout.on('data',b=>{output+=b.length});c.stderr.on('data',b=>{stderr+=b.length});c.on('error',reject);c.stdin.on('error',()=>{})
  c.on('close',code=>{clearTimeout(timer);resolve({code,output,stderr})});if(partial)c.stdin.write(Buffer.from([0]));else c.stdin.end()
 })}
 assert.equal((await child({},false)).code,78)
 assert.equal((await child({NODE_ENV:'test'},false)).code,78)
 const timed=await child({NODE_ENV:'test',DYOFFICE_PDF_GENERATED_FIXTURE:'1'},true);assert.equal(timed.code,1);assert.equal(timed.output,0);assert.ok(timed.stderr<=4096)
})
