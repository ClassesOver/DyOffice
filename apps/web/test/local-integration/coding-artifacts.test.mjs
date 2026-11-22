import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID,createHash} from 'node:crypto'
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {restrictedFixture} from '../helpers/restricted.mjs'
import {createLocalObjectStore} from '../../server/src/storage/local-dev.ts'
import {createHarnessArtifacts} from '../../server/src/modules/coding/artifacts.ts'
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
const binding=()=>({taskId:randomUUID(),claimId:randomUUID(),epoch:1})
async function fixture(t,wrap=objects=>objects) {
 const f=await restrictedFixture(t,{businessMax:4})
 const directory=await mkdtemp(join(tmpdir(),'office-artifacts-'))
 t.after(()=>rm(directory,{recursive:true,force:true}))
 const objects=await createLocalObjectStore({directory}),service=createHarnessArtifacts({transactions:f.transactions,objects:wrap(objects)})
 const stage=(b,bytes=Buffer.from('print(42)'),extra={})=>service.stage(f.alice.token,{...b,name:'analysis.py',mediaType:'text/x-python',role:'code',inputResultIds:[],sha256:hash(bytes),...extra},bytes)
 const commit=(b,artifactIds,extra={})=>({...b,commandId:randomUUID(),summary:'Implemented and tested',artifactIds,inputs:[],runtimeManifestSha256:'a'.repeat(64),limitations:[],...extra})
 const account=()=>f.transactions.withPrincipalTransaction({kind:'session',token:f.alice.token},async c=>Number((await c.query('SELECT used_bytes FROM harness_artifact_accounts')).rows[0]?.used_bytes??0))
 return {...f,directory,objects,service,stage,commit,account}
}

test('durable receipt and owned bytes survive runner deletion and service reconstruction; replay is exact',async t=>{
 const f=await fixture(t),b=binding(),runner=await mkdtemp(join(tmpdir(),'office-runner-'))
 const path=join(runner,'analysis.py');await writeFile(path,'print(42)')
 const artifact=await f.stage(b,await readFile(path)),command=f.commit(b,[artifact.artifactId])
 await assert.rejects(f.service.download(f.alice.token,artifact.artifactId))
 const delivery=await f.service.commit(f.alice.token,command)
 assert.equal(delivery.claimId,b.claimId);assert.equal(delivery.connectionEpoch,b.epoch)
 await rm(runner,{recursive:true,force:true})
 const restored=createHarnessArtifacts({transactions:f.transactions,objects:await createLocalObjectStore({directory:f.directory})})
 assert.deepEqual(await restored.receipt(f.alice.token,command.commandId),delivery)
 assert.deepEqual(await restored.commit(f.alice.token,command),delivery)
 assert.equal((await restored.download(f.alice.token,artifact.artifactId)).bytes.toString(),'print(42)')
 await assert.rejects(restored.commit(f.alice.token,{...command,summary:'different'}),{statusCode:409})
 assert.deepEqual(await restored.cancel(f.alice.token,b),{removed:0})
 assert.equal((await restored.download(f.alice.token,artifact.artifactId)).bytes.toString(),'print(42)')
 assert.equal(await f.account(),9)
})

test('cross-owner task, receipt and artifact access, stale claim and raw runtime mutations cannot escape ownership',async t=>{
 const f=await fixture(t),b=binding(),artifact=await f.stage(b),command=f.commit(b,[artifact.artifactId])
 await assert.rejects(f.service.commit(f.alice.token,{...command,claimId:randomUUID()}))
 await assert.rejects(f.service.stage(f.bob.token,{...b,name:'evil.py',mediaType:'text/plain',role:'code',inputResultIds:[],sha256:hash(Buffer.from('x'))},Buffer.from('x')))
 await f.service.commit(f.alice.token,command)
 await assert.rejects(f.service.read(f.bob.token,artifact.artifactId),{statusCode:404})
 await assert.rejects(f.service.download(f.bob.token,artifact.artifactId),{statusCode:404})
 await assert.rejects(f.service.receipt(f.bob.token,command.commandId),{statusCode:404})
 assert.equal((await f.businessPool.query('SELECT * FROM harness_artifacts')).rowCount,0)
 await assert.rejects(f.businessPool.query("UPDATE harness_artifacts SET object_key='forged'"),{code:'42501'})
 await assert.rejects(f.businessPool.query('DELETE FROM harness_analysis_deliveries'),{code:'42501'})
 await f.sessions.logout(f.alice.token)
 await assert.rejects(f.service.download(f.alice.token,artifact.artifactId))
})

test('12-file task cap and owner physical budget include reservations; cancel reclaims only staged objects',async t=>{
 const f=await fixture(t),b=binding()
 for(let i=0;i<12;i++)await f.stage(b,Buffer.from('x'),{name:i+'.txt'})
 await assert.rejects(f.stage(b,Buffer.from('x')),{statusCode:413})
 assert.equal(await f.account(),12)
 assert.deepEqual(await f.service.cancel(f.alice.token,b),{removed:12})
 assert.equal(await f.account(),0)
 const large=binding(),bytes=Buffer.alloc(8*1024*1024,1)
 await f.stage(large,bytes);await f.stage(large,bytes,{name:'second.bin'})
 await assert.rejects(f.stage(binding(),Buffer.from('x')),{statusCode:413})
 assert.equal(await f.account(),16*1024*1024)
 await f.service.cancel(f.alice.token,large);assert.equal(await f.account(),0)
})

test('ambiguous object upload remains accounted until physical cleanup; commit refuses incomplete artifacts',async t=>{
 let key
 const f=await fixture(t,objects=>({...objects,async putImmutable(objectKey,bytes,expected){key=objectKey;await objects.putImmutable(objectKey,bytes,expected);throw Error('lost storage response')}})),b=binding()
 await assert.rejects(f.stage(b),/lost storage response/)
 assert.equal(await f.account(),9)
 const artifact=(await f.transactions.withPrincipalTransaction({kind:'session',token:f.alice.token},async c=>(await c.query('SELECT artifact_id FROM harness_artifacts')).rows[0])).artifact_id
 await assert.rejects(f.service.commit(f.alice.token,f.commit(b,[artifact])),{statusCode:409})
 await f.objects.verifyObject({key,size:9,sha256:hash(Buffer.from('print(42)'))})
 await f.service.cancel(f.alice.token,b);assert.equal(await f.account(),0)
 await assert.rejects(f.objects.readVerified({key,size:9,sha256:hash(Buffer.from('print(42)'))}))
})

test('committed lineage must include every result referenced by an artifact',async t=>{
 const f=await fixture(t),b=binding(),resultId=randomUUID()
 const artifact=await f.stage(b,Buffer.from('derived'),{inputResultIds:[resultId]})
 const command=f.commit(b,[artifact.artifactId])
 await assert.rejects(f.service.commit(f.alice.token,command),{statusCode:409})
 const input={resultId,sha256:'b'.repeat(64),sourceId:'ledger',sourceVersion:1,queryHash:'c'.repeat(64),rowCount:1,truncated:false}
 const receipt=await f.service.commit(f.alice.token,{...command,inputs:[input]})
 assert.deepEqual(receipt.inputs,[input]);assert.deepEqual(receipt.artifacts[0].inputResultIds,[resultId])
})

test('committed deliveries are reclaimed oldest first when a new task needs room; the budget is not a lifetime total',async t=>{
 const f=await fixture(t),bytes=Buffer.alloc(8*1024*1024,2)
 const older=binding(),newer=binding()
 const first=await f.stage(older,bytes,{name:'older.bin'})
 await f.service.commit(f.alice.token,f.commit(older,[first.artifactId]))
 const second=await f.stage(newer,bytes,{name:'newer.bin'})
 await f.service.commit(f.alice.token,f.commit(newer,[second.artifactId]))
 assert.equal(await f.account(),16*1024*1024)
 // Before the fix this was a permanent 413 for the owner.
 const next=binding(),small=Buffer.from('fresh chart')
 const fresh=await f.stage(next,small,{name:'fresh.txt'})
 assert.equal(await f.account(),8*1024*1024+small.length)
 await assert.rejects(f.service.download(f.alice.token,first.artifactId),{statusCode:404})
 assert.equal((await f.service.download(f.alice.token,second.artifactId)).bytes.length,bytes.length)
 assert.ok(fresh.artifactId)
 // Staged files of a live task are never reclaimed for another task.
 await f.stage(next,bytes,{name:'big.bin'})
 await assert.rejects(f.stage(binding(),bytes,{name:'third.bin'}),{statusCode:413})
})

test('reclamation that cannot free enough fails with 413 and leaves committed files downloadable',async t=>{
 const f=await fixture(t),mib=1024*1024
 const done=binding(),small=Buffer.alloc(mib,3)
 const kept=await f.stage(done,small,{name:'kept.bin'})
 await f.service.commit(f.alice.token,f.commit(done,[kept.artifactId]))
 const live=binding()
 await f.stage(live,Buffer.alloc(8*mib,4),{name:'a.bin'})
 await f.stage(live,Buffer.alloc(7*mib,5),{name:'b.bin'})
 assert.equal(await f.account(),16*mib)
 await assert.rejects(f.stage(binding(),Buffer.alloc(8*mib,6),{name:'too-big.bin'}),{statusCode:413})
 assert.equal(await f.account(),16*mib)
 assert.deepEqual((await f.service.download(f.alice.token,kept.artifactId)).bytes,small)
})
