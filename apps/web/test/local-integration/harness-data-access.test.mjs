// Real restricted PostgreSQL services: this exercises RLS/owner/session checks,
// not a mocked source identity or fabricated result-reader permission check.
import test from 'node:test'
import assert from 'node:assert/strict'
import {randomBytes,createHash} from 'node:crypto'
import {restrictedFixture} from '../helpers/restricted.mjs'
import {createSourceService} from '../../server/src/modules/sources/service.ts'
import {createWorkspaceSourceResults} from '../../server/src/modules/sources/results.ts'
import {createWorkspaceSourceTools} from '../../server/src/modules/sources/tools.ts'
import {createQuerySnapshot} from '../../server/src/modules/sources/provenance.ts'
import {createHarnessDataAccess} from '../../server/src/modules/coding/data-access.ts'

test('task grants preserve real frozen-result RLS, result-only scope and live owner-session revocation',async t=>{
  const f=await restrictedFixture(t,{businessMax:4})
  const sources=createSourceService({transactions:f.transactions,credentialKeys:'test:'+randomBytes(32).toString('base64')})
  const results=createWorkspaceSourceResults({transactions:f.transactions})
  const tools=createWorkspaceSourceTools({sources,results})
  const access=createHarnessDataAccess({tools,results,sessions:f.sessions});t.after(()=>access.dispose())
  for(const token of [f.alice.token,f.bob.token]) {
    await sources.create(token,{sourceId:'metrics',name:'Metrics',kind:'http',config:{timezone:'UTC'},secret:'https://fixture.invalid/data'})
    await sources.publish(token,'metrics',{expectedVersion:1})
  }
  const snapshot=createQuerySnapshot({sourceId:'metrics',sourceVersion:1,timezone:'UTC',schema:[{name:'amount',type:'number',unit:'CNY'}],rows:[{amount:42}],sourceTruncated:false})
  const queryHash=createHash('sha256').update('bounded fixture').digest('hex')
  const aliceResult=await results.capture(f.alice.token,snapshot,queryHash)
  const bobResult=await results.capture(f.bob.token,snapshot,queryHash)
  const issue=(token,resultId)=>access.issue({token,agentId:'peer',inputs:{sourceIds:[],resultIds:[resultId]},signal:new AbortController().signal})
  await assert.rejects(issue(f.bob.token,aliceResult.resultId))
  await assert.rejects(issue(f.alice.token,bobResult.resultId))
  const alice=await issue(f.alice.token,aliceResult.resultId),bob=await issue(f.bob.token,bobResult.resultId)
  await assert.rejects(access.download(alice.taskId,bob.credential,aliceResult.resultId))
  await assert.rejects(access.download(alice.taskId,alice.credential,bobResult.resultId))
  await assert.rejects(access.execute(alice.taskId,alice.credential,'sources.query',{sourceId:'metrics',sql:'SELECT 1'}))
  const metadata=await access.execute(alice.taskId,alice.credential,'results.get_manifest',{resultId:aliceResult.resultId})
  assert.equal(metadata.artifact.resultId,aliceResult.resultId);assert.equal('rows' in metadata,false)
  const output=await access.download(alice.taskId,alice.credential,aliceResult.resultId)
  assert.deepEqual(JSON.parse(Buffer.from(output.bytes).toString()).rows,[{amount:42}])
  const visible=await f.transactions.withPrincipalTransaction({kind:'session',token:f.alice.token},async c=>(await c.query('SELECT result_id FROM workspace_source_results')).rows)
  assert.deepEqual(visible.map(row=>row.result_id),[aliceResult.resultId])
  await f.sessions.logout(f.alice.token)
  await assert.rejects(access.download(alice.taskId,alice.credential,aliceResult.resultId))
  assert.equal((await access.download(bob.taskId,bob.credential,bobResult.resultId)).sha256,snapshot.sha256)
})
