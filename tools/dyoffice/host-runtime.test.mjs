import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {validateHost,lock} from './host-runtime.mjs'
const good=()=>({node:{version:lock.node.version,sha256:lock.node.sha256},platform:'linux',arch:'x64',os:{ID:'ubuntu',VERSION_ID:'24.04'},packages:{...lock.packages},postgresVersion:'170012',redisVersion:'7.0.15',systemdVersion:'255',cgroup:'cgroup2fs'})
test('actual host admission rejects drift and unsupported ABI',()=>{
 assert.doesNotThrow(()=>validateHost(good()))
 for(const [key,value] of [['platform','darwin'],['arch','arm64'],['postgresVersion','170011'],['redisVersion','7.0.14'],['systemdVersion','254'],['cgroup','tmpfs']])assert.throws(()=>validateHost({...good(),[key]:value}))
 assert.throws(()=>validateHost({...good(),packages:{...lock.packages,'redis-server':'unexpected'}}))
 assert.throws(()=>validateHost({...good(),node:{...good().node,sha256:'0'.repeat(64)}}))
})
test('provisioner pins signed apt artifacts and does not trust mutable key bytes',async()=>{
 const s=await readFile(new URL('./ci-host-services.sh',import.meta.url),'utf8')
 assert.match(s,/B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8/)
 for(const [name,version] of Object.entries(lock.packages))assert.ok(s.includes(`${name}=${version}`),name)
 assert.match(s,/sha256sum --check --strict/)
 assert.doesNotMatch(s,/allow-unauthenticated|trusted=yes/)
})
test('optional native and object-store profiles fail closed when requested',()=>{
 assert.throws(()=>validateHost(good(),{native:true}))
 assert.throws(()=>validateHost(good(),{objectstore:true}))
 assert.doesNotThrow(()=>validateHost({...good(),rust:{rustc:'rustc 1.93.0 (example)',cargo:'cargo 1.93.0 (example)'},objectstore:{archiveSha256:'4f0bf3fecbe861467427ff506aee22c302cfd5ac8b7dcbde71714f8e5e680dea',ready:true}},{native:true,objectstore:true}))
})
test('all three host jobs run Node admission before install and service admission before regression',async()=>{
 const s=await readFile(new URL('../../.github/workflows/dyoffice-web-boundaries.yml',import.meta.url),'utf8')
 const jobs=s.split(/^  (?:boundary-check|native-docx|native-worker):/m).slice(1)
 assert.equal(jobs.length,3)
 for(const job of jobs){const guard=job.indexOf('host-runtime.mjs --node-only'),install=job.indexOf('npm ci');assert.ok(guard>=0&&install>=0);assert.ok(guard<install);assert.equal((job.match(/name: Verify actual/g)||[]).length,1);assert.match(job,/path: .dyoffice-runtime-evidence\/host-runtime.json/)}
})
test('artifact hashing streams more than 256 MiB without buffering stdout',async()=>{
 const {hashCommand}=await import('./host-runtime.mjs')
 const {createHash}=await import('node:crypto')
 const chunk=Buffer.alloc(1024*1024,65),expected=createHash('sha256')
 for(let i=0;i<257;i++)expected.update(chunk)
 assert.equal(await hashCommand(process.execPath,['-e',"const b=Buffer.alloc(1024*1024,65); let n=257; function write(){while(n-- >0)if(!process.stdout.write(b)){process.stdout.once('drain',write);return}}write()"]),expected.digest('hex'))
 await assert.rejects(hashCommand(process.execPath,['-e','process.exit(2)']))
})
