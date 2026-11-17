// Real PostgreSQL/RLS receipt storage with synthetic local-only inputs.
import test from 'node:test'
import assert from 'node:assert/strict'
import {randomBytes,randomUUID,createHash} from 'node:crypto'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {restrictedFixture} from '../helpers/restricted.mjs'
import {createLocalObjectStore} from '../../server/src/storage/local-dev.ts'
import {createHarnessArtifacts} from '../../server/src/modules/coding/artifacts.ts'
import {createSourceService} from '../../server/src/modules/sources/service.ts'
import {createWorkspaceSourceResults} from '../../server/src/modules/sources/results.ts'
import {createWorkspaceSourceTools} from '../../server/src/modules/sources/tools.ts'
import {createQuerySnapshot} from '../../server/src/modules/sources/provenance.ts'
import {createHarnessDataAccess} from '../../server/src/modules/coding/data-access.ts'
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')

test('PG receipt recovery survives input expiry without writes and rejects cross-task, owner and revoked sessions',async t=>{
 const f=await restrictedFixture(t,{businessMax:4,buildApp:false})
 const directory=await mkdtemp(join(tmpdir(),'harness-receipt-'))
 t.after(()=>rm(directory,{recursive:true,force:true}))
 const artifacts=createHarnessArtifacts({transactions:f.transactions,objects:await createLocalObjectStore({directory})})
 const sources=createSourceService({transactions:f.transactions,credentialKeys:'test:'+randomBytes(32).toString('base64')})
 const results=createWorkspaceSourceResults({transactions:f.transactions}),tools=createWorkspaceSourceTools({sources,results})
 const access=createHarnessDataAccess({tools,results,sessions:f.sessions,artifacts});t.after(()=>access.dispose())
 await sources.create(f.alice.token,{sourceId:'metrics',name:'Metrics',kind:'http',config:{timezone:'UTC'},secret:'https://fixture.invalid/data'})
 await sources.publish(f.alice.token,'metrics',{expectedVersion:1})
 const snapshot=createQuerySnapshot({sourceId:'metrics',sourceVersion:1,timezone:'UTC',schema:[{name:'amount',type:'number'}],rows:[{amount:42}],sourceTruncated:false})
 const captured=await results.capture(f.alice.token,snapshot,hash('fixture only'))
 const issue=(token,inputs,extra={})=>access.issue({token,agentId:'external',inputs,signal:new AbortController().signal,...extra})
 const g=await issue(f.alice.token,{sourceIds:[],resultIds:[captured.resultId]})
 const execute=(operation,args)=>access.execute(g.taskId,g.credential,operation,args)
 const bytes=Buffer.from('Local analysis report')
 const staged=await execute('artifacts.stage',{name:'report.txt',mediaType:'text/plain',role:'report',inputResultIds:[captured.resultId],sha256:hash(bytes),bytesBase64:bytes.toString('base64')})
 const input=Object.fromEntries(['resultId','sha256','sourceId','sourceVersion','queryHash','rowCount','truncated'].map(key=>[key,captured[key]]))
 const commandId=randomUUID()
 const receipt=await execute('artifacts.commit',{commandId,summary:'Local fixture',artifactIds:[staged.artifactId],inputs:[input],runtimeManifestSha256:hash('runtime'),limitations:['Synthetic input']})
 const owner=await f.ownerPool.connect()
 try {
  await owner.query('BEGIN')
  await owner.query("SELECT set_config('dyoffice.deployment_id',$1,true),set_config('dyoffice.user_id',$2,true)",[f.deploymentId,f.alice.user.id])
  const changed=await owner.query("UPDATE workspace_source_results SET expires_at=now()-interval '1 second' WHERE result_id=$1",[captured.resultId])
  assert.equal(changed.rowCount,1)
  await owner.query('COMMIT')
 } catch(error) {await owner.query('ROLLBACK');throw error} finally {owner.release()}
 await assert.rejects(results.read(f.alice.token,{resultId:captured.resultId,limit:1}))
 assert.deepEqual(await execute('artifacts.get_receipt',{commandId}),receipt)
 const count=await f.transactions.withPrincipalTransaction({kind:'session',token:f.alice.token},async c=>c.query('SELECT count(*)::int AS count FROM harness_analysis_deliveries'))
 assert.equal(count.rows[0].count,1)
 const second=await issue(f.alice.token,{sourceIds:[],resultIds:[]})
 await assert.rejects(access.execute(second.taskId,second.credential,'artifacts.get_receipt',{commandId}))
 const bob=await issue(f.bob.token,{sourceIds:[],resultIds:[]})
 await assert.rejects(access.execute(bob.taskId,bob.credential,'artifacts.get_receipt',{commandId}))
 access.revoke(second.taskId)
 const expired=await issue(f.alice.token,{sourceIds:[],resultIds:[]},{ttlMs:100})
 await new Promise(resolve=>setTimeout(resolve,150))
 await assert.rejects(access.execute(expired.taskId,expired.credential,'artifacts.get_receipt',{commandId}))
 await f.sessions.logout(f.alice.token)
 await assert.rejects(execute('artifacts.get_receipt',{commandId}))
})
