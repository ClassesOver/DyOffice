import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {createHarnessDataAccess} from '../../server/src/modules/coding/data-access.ts'
import {createWorkspaceSourceTools} from '../../server/src/modules/sources/tools.ts'
import {createQuerySnapshot} from '../../server/src/modules/sources/provenance.ts'

// Owner-scoped service stubs make boundary decisions observable. Real source
// authorization and snapshot checks remain in the existing source services.
function fixture(t,artifacts) {
  const calls=[],revoked=new Set(),records=new Map(),identities=new Map()
  const alice='a'.repeat(43),bob='b'.repeat(43)
  for(const token of [alice,bob])identities.set(token,{deploymentId:'deployment',userId:token===alice?'alice':'bob',sessionId:token,authVersion:1,roles:['personal']})
  const resultId=randomUUID(),foreignId=randomUUID()
  const artifact=(id,owner)=>({resultId:id,workspaceId:owner,sourceId:'sales',sourceVersion:1,queryHash:'a'.repeat(64),sha256:'b'.repeat(64),rowCount:1,truncated:false,sizeBytes:10,state:'saved',name:'data',createdAt:new Date().toISOString(),savedAt:new Date().toISOString(),expiresAt:null})
  records.set(resultId,{token:alice,artifact:artifact(resultId,'alice')});records.set(foreignId,{token:bob,artifact:artifact(foreignId,'bob')})
  const sessions={async authenticate(token){calls.push(['auth',token]);if(revoked.has(token)||!identities.has(token))throw Error('secret session detail');return {...identities.get(token)}}}
  const tools={async execute(token,input,documentId){
    calls.push(['tool',token,input,documentId]);const args=input.arguments
    if(input.name==='sources.list')return {items:[{sourceId:'sales',name:'Sales'},{sourceId:'other',name:'Private unrelated'}],nextCursor:null}
    if(token!==alice||args.sourceId!=='sales')throw Error('private source denial')
    if(input.name==='sources.describe')return {sourceId:'sales',schema:[{name:'revenue'}]}
    if(input.name==='sources.query') {
      const id=randomUUID(),entry={token,artifact:artifact(id,'alice')};records.set(id,entry)
      return {artifact:entry.artifact,schema:[{name:'revenue',type:'number',unit:'CNY'}],timezone:'Asia/Shanghai',preview:[{revenue:42}],rows:[{revenue:42}],totalRows:1,sourceTruncated:false,sha256:entry.artifact.sha256,nextOffset:null,notice:'Frozen'}
    }
    throw Error('unsupported')
  }}
  const results={async read(token,{resultId:id}){calls.push(['read',token,id]);const r=records.get(id);if(!r||r.token!==token)throw Error('foreign result');return {artifact:r.artifact,schema:[{name:'revenue',type:'number',unit:'CNY'}],timezone:'Asia/Shanghai',rows:[{revenue:42}],offset:0,nextOffset:null,totalRows:1,sourceTruncated:false,sha256:r.artifact.sha256}},async download(token,id){calls.push(['download',token,id]);const r=records.get(id);if(!r||r.token!==token)throw Error('foreign result');return {name:'result.json',bytes:Buffer.from('{"revenue":42}'),sha256:r.artifact.sha256}}}
  const access=createHarnessDataAccess({sessions,tools,results,...(artifacts?{artifacts}:{})});t.after(()=>access.dispose())
  const issue=(inputs={sourceIds:['sales'],resultIds:[]},extras={})=>access.issue({token:alice,agentId:'codex',inputs,signal:new AbortController().signal,...extras})
  return {access,alice,bob,resultId,foreignId,records,calls,revoked,identities,sessions,tools,results,issue}
}

test('issues task-only credentials, filters source catalog, strips all data rows and allows frozen download',async t=>{
  const f=fixture(t),grant=await f.issue()
  assert.match(grant.credential,/^[A-Za-z0-9_-]{43}$/)
  assert.equal(grant.connectionEpoch,1);assert.doesNotMatch(JSON.stringify(grant),new RegExp(f.alice))
  const list=await f.access.execute(grant.taskId,grant.credential,'sources.list',{})
  assert.deepEqual(list,{items:[{sourceId:'sales',name:'Sales'}],nextCursor:null})
  const outcome=await f.access.execute(grant.taskId,grant.credential,'sources.query',{sourceId:'sales',sql:'SELECT revenue FROM sales'})
  assert.equal('preview' in outcome,false);assert.equal('rows' in outcome,false);assert.equal(outcome.totalRows,1)
  const manifest=await f.access.execute(grant.taskId,grant.credential,'results.get_manifest',{resultId:outcome.artifact.resultId})
  assert.equal('rows' in manifest,false);assert.equal(manifest.artifact.resultId,outcome.artifact.resultId)
  assert.equal((await f.access.download(grant.taskId,grant.credential,outcome.artifact.resultId)).name,'result.json')
  assert.equal(f.calls.filter(x=>x[0]==='tool'&&x[2].name==='sources.query').length,1)
})

test('task and owner bounds prevent credential reuse, foreign inputs and result-only reverse querying',async t=>{
  const f=fixture(t),first=await f.issue(),second=await f.issue({sourceIds:[],resultIds:[f.resultId]})
  await assert.rejects(f.access.execute(second.taskId,first.credential,'sources.list',{}))
  await assert.rejects(f.access.execute(second.taskId,second.credential,'sources.query',{sourceId:'sales',sql:'SELECT 1'}))
  await assert.rejects(f.access.download(second.taskId,second.credential,f.foreignId))
  assert.equal((await f.access.download(second.taskId,second.credential,f.resultId)).name,'result.json')
  f.access.revoke(first.taskId)
  await assert.rejects(f.issue({sourceIds:[],resultIds:[f.foreignId]}))
  await assert.rejects(f.issue({sourceIds:['other'],resultIds:[]}))
})

test('unknown operations, extra arguments and off-scope sources never dispatch to source tools',async t=>{
  const f=fixture(t),g=await f.issue();f.calls.length=0
  for(const [operation,args] of [
    ['sources.save_result',{resultId:f.resultId,name:'x'}],
    ['sources.query',{sourceId:'other',sql:'SELECT 1'}],
    ['sources.query',{sourceId:'sales',sql:'SELECT 1',ownerId:'bob'}],
    ['sources.describe',{sourceId:'sales',token:f.bob}],
    ['results.get_manifest',{resultId:f.resultId,path:'/etc/passwd'}],
    ['sources.list',{ownerId:'bob'}],
  ])await assert.rejects(f.access.execute(g.taskId,g.credential,operation,args))
  assert.equal(f.calls.some(x=>x[0]==='tool'),false)
})

test('revocation, parent cancellation, expiry and identity changes revoke grants',async t=>{
  const f=fixture(t),controller=new AbortController(),g=await f.issue(undefined,{signal:controller.signal})
  controller.abort();await assert.rejects(f.access.execute(g.taskId,g.credential,'sources.list',{}))
  const revoked=await f.issue();f.revoked.add(f.alice)
  await assert.rejects(f.access.execute(revoked.taskId,revoked.credential,'sources.list',{}),/Harness data unavailable/)
  f.revoked.delete(f.alice)
  const moved=await f.issue();f.identities.get(f.alice).sessionId='replacement-session'
  await assert.rejects(f.access.execute(moved.taskId,moved.credential,'sources.list',{}))
  f.identities.get(f.alice).sessionId=f.alice
  const expired=await f.issue(undefined,{ttlMs:5});await new Promise(resolve=>setTimeout(resolve,15))
  await assert.rejects(f.access.execute(expired.taskId,expired.credential,'sources.list',{}))
})

test('an operation completing after cancellation cannot return rows or newly grant its result',async t=>{
  const f=fixture(t),g=await f.issue();let release,started
  const ready=new Promise(resolve=>{started=resolve}),original=f.tools.execute
  f.tools.execute=async(token,input)=>{if(input.name==='sources.query'){started();await new Promise(resolve=>{release=resolve})}return original(token,input)}
  const pending=f.access.execute(g.taskId,g.credential,'sources.query',{sourceId:'sales',sql:'SELECT 1'})
  await ready;f.access.revoke(g.taskId);release();await assert.rejects(pending)
})

test('issued grant and caller input are snapshots, and per-owner admission includes pending issues',async t=>{
  const f=fixture(t),inputs={sourceIds:['sales'],resultIds:[]},g=await f.issue(inputs)
  const originalId=g.taskId
  inputs.sourceIds.push('other');g.inputs.sourceIds.push('other');g.taskId=randomUUID()
  await assert.rejects(f.access.execute(originalId,g.credential,'sources.describe',{sourceId:'other'}))
  const second=await f.issue()
  await assert.rejects(f.issue(),e=>e.statusCode===429)
  await assert.rejects(f.access.execute(second.taskId,second.credential,'sources.describe',{sourceId:'other'}))
  f.access.revoke(second.taskId)
  let release,started;const ready=new Promise(resolve=>{started=resolve}),original=f.tools.execute
  f.tools.execute=async(token,input)=>{if(input.name==='sources.describe'){started();await new Promise(resolve=>{release=resolve})}return original(token,input)}
  const pending=f.issue();await ready
  await assert.rejects(f.issue(),e=>e.statusCode===429)
  release();await pending
})

test('invalid issue fields and scopes are rejected before tools execute; disposal prevents issue',async t=>{
  const f=fixture(t)
  for(const extras of [{ttlMs:900001},{ttlMs:0},{ownerId:'bob'},{agentId:'bad agent'}])await assert.rejects(f.issue(undefined,extras))
  for(const inputs of [{sourceIds:['sales'],resultIds:[],ownerId:'bob'},{sourceIds:['sales'],resultIds:['not-uuid']},{sourceIds:Array(33).fill('sales'),resultIds:[]}])await assert.rejects(f.issue(inputs))
  assert.equal(f.calls.some(x=>x[0]==='tool'),false)
  f.access.dispose();await assert.rejects(f.issue())
})

test('source errors are redacted and queries are not implicitly retried',async t=>{
  const f=fixture(t),g=await f.issue();let queries=0
  f.tools.execute=async()=>{queries++;throw Error('dsn=secret; password=private')}
  await assert.rejects(f.access.execute(g.taskId,g.credential,'sources.query',{sourceId:'sales',sql:'SELECT 1'}),{message:'Harness data unavailable'})
  assert.equal(queries,1)
})

test('global admission stays at sixteen tasks across owners and disposal releases all credentials',async t=>{
  const f=fixture(t),grants=[]
  for(let owner=0;owner<8;owner++) {
    const token=String(owner).repeat(43)
    f.identities.set(token,{deploymentId:'deployment',userId:'owner'+owner,sessionId:token,authVersion:1,roles:['personal']})
    for(let i=0;i<2;i++)grants.push(await f.issue({sourceIds:[],resultIds:[]},{token}))
  }
  await assert.rejects(f.issue({sourceIds:[],resultIds:[]}),e=>e.statusCode===429)
  f.access.dispose()
  for(const grant of grants)await assert.rejects(f.access.execute(grant.taskId,grant.credential,'sources.list',{}))
})

test('source catalog scans original pages without leaking unrelated cursors or names',async t=>{
  const f=fixture(t),g=await f.issue();let pages=0
  f.tools.execute=async(_token,input)=>{
    assert.equal(input.name,'sources.list');pages++
    return input.arguments.after===undefined
      ?{items:[{sourceId:'hidden',name:'Never expose'}],nextCursor:'hidden'}
      :{items:[{sourceId:'sales',name:'Sales'}],nextCursor:'unrelated-next'}
  }
  const catalog=await f.access.execute(g.taskId,g.credential,'sources.list',{})
  assert.equal(pages,2);assert.deepEqual(catalog,{items:[{sourceId:'sales',name:'Sales'}],nextCursor:null})
  assert.doesNotMatch(JSON.stringify(catalog),/hidden|unrelated|Never expose/)
})

test('artifact operations privately bind owner and claim and enforce scoped, verified input evidence',async t=>{
  const calls=[],artifacts={async stage(token,input,bytes){calls.push(['stage',token,input,bytes]);return {artifactId:randomUUID(),...input,sizeBytes:bytes.length}},async commit(token,input){calls.push(['commit',token,input]);return input}}
  const f=fixture(t,artifacts),g=await f.issue({sourceIds:[],resultIds:[f.resultId]})
  assert.equal(await f.access.delivery(g.taskId,g.credential),undefined)
  assert.deepEqual(await f.access.authorize(g.taskId,g.credential),{taskId:g.taskId,claimId:g.claimId,connectionEpoch:1,agentId:'codex'})
  const args={name:'report.txt',mediaType:'text/plain',role:'report',inputResultIds:[f.resultId],sha256:'a'.repeat(64),bytesBase64:Buffer.from('Report').toString('base64')}
  const staged=await f.access.execute(g.taskId,g.credential,'artifacts.stage',args)
  assert.equal(calls[0][1],f.alice);assert.equal(calls[0][2].taskId,g.taskId);assert.equal(calls[0][2].claimId,g.claimId);assert.equal(calls[0][2].epoch,1)
  assert.equal(calls[0][3].toString(),'Report')
  for(const extra of [{taskId:randomUUID()},{ownerId:'bob'},{claimId:randomUUID()}])await assert.rejects(f.access.execute(g.taskId,g.credential,'artifacts.stage',{...args,...extra}))
  await assert.rejects(f.access.execute(g.taskId,g.credential,'artifacts.stage',{...args,inputResultIds:[f.foreignId]}))
  await assert.rejects(f.access.execute(g.taskId,g.credential,'artifacts.stage',{...args,bytesBase64:'bad'}))
  const artifact=f.records.get(f.resultId).artifact
  const ref=Object.fromEntries(['resultId','sha256','sourceId','sourceVersion','queryHash','rowCount','truncated'].map(key=>[key,artifact[key]]))
  const commit={commandId:randomUUID(),summary:'Done',artifactIds:[staged.artifactId],inputs:[ref],runtimeManifestSha256:'c'.repeat(64),limitations:[]}
  await assert.rejects(f.access.execute(g.taskId,g.credential,'artifacts.commit',{...commit,inputs:[{...ref,sha256:'d'.repeat(64)}]}))
  await assert.rejects(f.access.execute(g.taskId,g.credential,'artifacts.commit',{...commit,inputs:[{...ref,resultId:f.foreignId}]}))
  for(const spoof of [{timezone:'UTC'},{schema:[{name:'fake',type:'string'}]},{rows:[{secret:'hidden'}]}])await assert.rejects(f.access.execute(g.taskId,g.credential,'artifacts.commit',{...commit,inputs:[{...ref,...spoof}]}))
  const readSnapshot=f.results.read
  f.results.read=async(...args)=>{const page=await readSnapshot(...args);return {...page,schema:page.schema.map(column=>({...column,credentials:'do-not-copy'})),query:'do-not-copy'}}
  const committed=await f.access.execute(g.taskId,g.credential,'artifacts.commit',commit)
  assert.deepEqual(committed.inputs,[{...ref,schema:[{name:'revenue',type:'number',unit:'CNY'}],timezone:'Asia/Shanghai'}])
  assert.equal(calls[1][2].inputs[0].timezone,'Asia/Shanghai')
  assert.deepEqual(calls[1][2].inputs[0].schema,[{name:'revenue',type:'number',unit:'CNY'}])
  assert.equal('rows' in calls[1][2].inputs[0],false)
  assert.doesNotMatch(JSON.stringify(calls[1][2].inputs),/credentials|do-not-copy|\"query\":/)
  assert.equal(calls.length,2);assert.equal(calls[1][2].taskId,g.taskId);assert.equal(calls[1][2].claimId,g.claimId)
  committed.summary='Forged by caller'
  const delivery=await f.access.delivery(g.taskId,g.credential)
  assert.equal(delivery.summary,'Done');delivery.summary='Changed again'
  assert.equal((await f.access.delivery(g.taskId,g.credential)).summary,'Done')
})

test('channel claim binding is revalidated before and after data operations and permanently revokes a lost claim',async t=>{
 const f=fixture(t);let active=true,checks=0
 const authorize=async()=>{checks++;if(!active)throw Error('Channel claim no longer active')}
 const g=await f.issue(undefined,{authorize})
 const listed=await f.access.execute(g.taskId,g.credential,'sources.list',{})
 assert.equal(listed.items.length,1);assert.ok(checks>=3)
 let release,started;const ready=new Promise(resolve=>{started=resolve}),original=f.tools.execute
 f.tools.execute=async(token,input)=>{if(input.name==='sources.query'){started();await new Promise(resolve=>{release=resolve})}return original(token,input)}
 const query=f.access.execute(g.taskId,g.credential,'sources.query',{sourceId:'sales',sql:'SELECT 1'})
 await ready;active=false;release();await assert.rejects(query)
 active=true
 await assert.rejects(f.access.execute(g.taskId,g.credential,'sources.list',{}))
})

test('finished channel claims release bounded grant slots before the next task is admitted',async t=>{
 const f=fixture(t);let active=true
 const authorize=async()=>{if(!active)throw Error('Finished')}
 const first=await f.issue(undefined,{authorize}),second=await f.issue(undefined,{authorize})
 active=false
 const next=await f.issue()
 await assert.rejects(f.access.authorize(first.taskId,first.credential));await assert.rejects(f.access.authorize(second.taskId,second.credential))
 assert.ok(await f.access.authorize(next.taskId,next.credential))
})


test('committed receipt recovery does not reread expired inputs or repeat commit',async t=>{
 let stored,commits=0,reads=0
 const f=fixture(t,{async commit(_token,input){commits++;stored={...input,connectionEpoch:input.epoch};return stored},async receipt(token,id){reads++;assert.equal(token,f.alice);assert.equal(id,stored.commandId);return structuredClone(stored)}})
 const g=await f.issue({sourceIds:[],resultIds:[f.resultId]})
 const artifact=f.records.get(f.resultId).artifact
 const input=Object.fromEntries(['resultId','sha256','sourceId','sourceVersion','queryHash','rowCount','truncated'].map(key=>[key,artifact[key]]))
 const commandId=randomUUID()
 await f.access.execute(g.taskId,g.credential,'artifacts.commit',{commandId,summary:'Done',artifactIds:[randomUUID()],inputs:[input],runtimeManifestSha256:'c'.repeat(64),limitations:[]})
 f.records.delete(f.resultId);f.calls.length=0
 const receipt=await f.access.execute(g.taskId,g.credential,'artifacts.get_receipt',{commandId})
 assert.equal(receipt.commandId,commandId);assert.equal(commits,1);assert.equal(reads,1)
 assert.equal(f.calls.some(call=>call[0]==='read'||call[0]==='tool'),false)
 receipt.summary='Mutated'
 assert.equal((await f.access.delivery(g.taskId,g.credential)).summary,'Done')
})

test('receipt recovery rejects another task, claim, epoch and unknown arguments',async t=>{
 let receipt
 const f=fixture(t,{async receipt(){return receipt}}),g=await f.issue({sourceIds:[],resultIds:[]})
 const commandId=randomUUID(),valid={taskId:g.taskId,claimId:g.claimId,connectionEpoch:1,commandId}
 for(const change of [{taskId:randomUUID()},{claimId:randomUUID()},{connectionEpoch:2},{commandId:randomUUID()}]) {
  receipt={...valid,...change}
  await assert.rejects(f.access.execute(g.taskId,g.credential,'artifacts.get_receipt',{commandId}),/Harness data unavailable/)
 }
 receipt=valid
 await assert.rejects(f.access.execute(g.taskId,g.credential,'artifacts.get_receipt',{commandId,ownerId:'bob'}))
 await assert.rejects(f.access.execute(g.taskId,g.credential,'artifacts.get_receipt',{commandId:'invalid'}))
})

test('receipt recovery rechecks live claim after storage read',async t=>{
 let active=true,release,started
 const ready=new Promise(resolve=>{started=resolve})
 const f=fixture(t,{async receipt(){started();await new Promise(resolve=>{release=resolve});return {taskId:g.taskId,claimId:g.claimId,connectionEpoch:1,commandId}}})
 const g=await f.issue({sourceIds:[],resultIds:[]},{authorize:async()=>{if(!active)throw Error('revoked')}}),commandId=randomUUID()
 const pending=f.access.execute(g.taskId,g.credential,'artifacts.get_receipt',{commandId})
 await ready;active=false;release();await assert.rejects(pending)
})

test('expired frozen inputs never requery; a separate source query still needs an explicit source-scoped current grant',async t=>{
 const f=fixture(t),onlyResult=await f.issue({sourceIds:[],resultIds:[f.resultId]})
 f.results.read=async()=>{throw Object.assign(Error('expired'),{statusCode:410})}
 f.results.download=async()=>{throw Object.assign(Error('expired'),{statusCode:410})}
 f.calls.length=0
 await assert.rejects(f.access.execute(onlyResult.taskId,onlyResult.credential,'results.get_manifest',{resultId:f.resultId}))
 await assert.rejects(f.access.download(onlyResult.taskId,onlyResult.credential,f.resultId))
 await assert.rejects(f.access.execute(onlyResult.taskId,onlyResult.credential,'sources.query',{sourceId:'sales',sql:'SELECT 1'}))
 assert.equal(f.calls.some(call=>call[0]==='tool'),false,'failure must not query or expand a result-only grant')
 const source=await f.issue({sourceIds:['sales'],resultIds:[]})
 const outcome=await f.access.execute(source.taskId,source.credential,'sources.query',{sourceId:'sales',sourceVersion:1,sql:'SELECT 1'})
 assert.notEqual(outcome.artifact.resultId,f.resultId)
 assert.equal(f.calls.filter(call=>call[0]==='tool'&&call[2].name==='sources.query').length,1)
 f.revoked.add(f.alice)
 await assert.rejects(f.access.execute(source.taskId,source.credential,'sources.query',{sourceId:'sales',sql:'SELECT 1'}))
 assert.equal(f.calls.filter(call=>call[0]==='tool'&&call[2].name==='sources.query').length,1,'revoked source query never reaches connector')
})

test('a default grant outlives the 600 s Harness deadline plus setup and delivery', async () => {
  const { HARNESS_GRANT_DEFAULT_TTL_MS } = await import('../../server/src/modules/coding/data-access.ts')
  assert.ok(HARNESS_GRANT_DEFAULT_TTL_MS >= 600_000 + 60_000)
})

test('a task sees actionable statuses (budget, conflict) but revocation and private failures stay an opaque 403',async t=>{
  const status=code=>Object.assign(Error('private detail'),{statusCode:code})
  let next=status(413)
  const artifacts={async stage(){throw next},async commit(){throw next}}
  const f=fixture(t,artifacts),g=await f.issue({sourceIds:[],resultIds:[f.resultId]})
  const args={name:'report.txt',mediaType:'text/plain',role:'report',inputResultIds:[f.resultId],sha256:'a'.repeat(64),bytesBase64:Buffer.from('Report').toString('base64')}
  for(const code of [413,409]){
    next=status(code)
    await assert.rejects(f.access.execute(g.taskId,g.credential,'artifacts.stage',args),error=>error.statusCode===code&&!error.message.includes('private'))
  }
  next=Error('database password leaked in message')
  await assert.rejects(f.access.execute(g.taskId,g.credential,'artifacts.stage',args),error=>error.statusCode===403&&!error.message.includes('password'))
  f.revoked.add(f.alice)
  next=status(413)
  await assert.rejects(f.access.execute(g.taskId,g.credential,'artifacts.stage',args),error=>error.statusCode===403)
})

test('a data grant follows confirmed lease renewals and stops at the last confirmed deadline',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1000000})
  const f=fixture(t)
  let until=Date.now()+30000
  const grant=await f.issue(undefined,{leaseUntil:async()=>until})
  assert.equal(Date.parse(grant.expiresAt),until)
  until+=20000
  t.mock.timers.tick(30000)
  await new Promise(resolve=>setImmediate(resolve))
  await f.access.authorize(grant.taskId,grant.credential)
  t.mock.timers.tick(20000)
  await new Promise(resolve=>setImmediate(resolve))
  until+=30000
  await assert.rejects(f.access.authorize(grant.taskId,grant.credential),{statusCode:403})
})

function attachBatchTools(f,{onDetail,onStatement,documentId}={}) {
  const statements=[],captured=[]
  const sources={
    async detail(){await onDetail?.(captured);return {source:{version:1,enabled:true,hasCredential:true}}},
    async querySource(token,sourceId,{sql}){
      statements.push(sql)
      await onStatement?.(sql,token)
      return createQuerySnapshot({sourceId,sourceVersion:1,timezone:'UTC',schema:[{name:'n',type:'number'}],rows:[{n:statements.length}],sourceTruncated:false})
    },
  }
  const results={async requireDocument(token,id){assert.deepEqual([token,id],[f.alice,documentId])},async capture(token,snapshot,queryHash,id){
    assert.equal(id,documentId)
    const artifact={...f.records.get(f.resultId).artifact,resultId:randomUUID(),sha256:snapshot.sha256,queryHash,state:'pending',savedAt:null,name:null,expiresAt:new Date(Date.now()+60_000).toISOString()}
    captured.push(artifact.resultId)
    f.records.set(artifact.resultId,{token,artifact})
    return artifact
  }}
  f.tools.execute=createWorkspaceSourceTools({sources,results}).execute
  return {statements,captured}
}

test('batch SQL registers each frozen result in order without exposing rows and rechecks task access',async t=>{
  const f=fixture(t),documentId=randomUUID(),grant=await f.issue(undefined,{documentId})
  const {statements}=attachBatchTools(f,{documentId,onStatement(sql,token){if(sql==='SELECT 3')f.revoked.add(token)}})
  const run=queries=>f.access.execute(grant.taskId,grant.credential,'sources.query',{sourceId:'sales',queries})
  const {items}=await run(['SELECT 1','SELECT 2'])
  assert.equal(items.length,2)
  for(const item of items){
    assert.equal(item.ok,true)
    assert.equal('preview' in item.result,false)
    assert.ok(await f.access.download(grant.taskId,grant.credential,item.result.artifact.resultId))
  }
  await assert.rejects(run(['SELECT 3','SELECT 4']),{statusCode:403})
  assert.deepEqual(statements,['SELECT 1','SELECT 2','SELECT 3'])
  assert.ok(f.calls.filter(c=>c[0]==='tool').every(c=>c[3]===documentId))
})

test('a remote claim revoked during the final source check cannot acquire or return any batch result',async t=>{
  const f=fixture(t)
  const deadline=Date.now()+60_000
  let active=true
  const grant=await f.issue(undefined,{leaseUntil:async()=>{if(!active)throw Error('Claim ended');return deadline}})
  const {captured}=attachBatchTools(f,{onDetail(ids){if(ids.length)active=false}})
  await assert.rejects(f.access.execute(grant.taskId,grant.credential,'sources.query',{sourceId:'sales',queries:['SELECT 1']}),{statusCode:403})
  assert.equal(captured.length,1)
  active=true
  await assert.rejects(f.access.download(grant.taskId,grant.credential,captured[0]),{statusCode:403})
  assert.equal(f.calls.some(call=>call[0]==='download'),false)
})

test('the task checks its 64-result limit before dispatching a batch',async t=>{
  const f=fixture(t),grant=await f.issue()
  const query=args=>f.access.execute(grant.taskId,grant.credential,'sources.query',{sourceId:'sales',...args})
  for(let i=0;i<63;i++)await query({sql:'SELECT 1'})
  f.calls.length=0
  await assert.rejects(query({queries:['SELECT 1','SELECT 2']}),{statusCode:429})
  assert.equal(f.calls.some(call=>call[0]==='tool'),false)
  await query({sql:'SELECT 1'})
  await assert.rejects(query({sql:'SELECT 1'}),{statusCode:429})
})
