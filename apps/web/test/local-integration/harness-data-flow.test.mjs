// Real PG17/RLS + HTTP connector + task HTTP API + disk object store. A separate
// fixture harness uses the same CLI client as built-in/external transports.
// Model inference is deliberately outside this deterministic data-flow test.
import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import {createServer} from 'node:http'
import {spawn} from 'node:child_process'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {randomBytes} from 'node:crypto'
import {restrictedFixture} from '../helpers/restricted.mjs'
import {createSourceService} from '../../server/src/modules/sources/service.ts'
import {createWorkspaceSourceResults} from '../../server/src/modules/sources/results.ts'
import {createWorkspaceSourceTools} from '../../server/src/modules/sources/tools.ts'
import {createHarnessDataAccess} from '../../server/src/modules/coding/data-access.ts'
import {createHarnessArtifacts} from '../../server/src/modules/coding/artifacts.ts'
import {registerHarnessDataRoutes} from '../../server/src/modules/coding/data-routes.ts'
import {createCodingHarness} from '../../server/src/modules/coding/harness.ts'
import {createCodingModelBridge} from '../../server/src/modules/coding/model-bridge.ts'
import {createLocalObjectStore} from '../../server/src/storage/local-dev.ts'

const root=resolve(fileURLToPath(new URL('../../../..',import.meta.url)))
async function runHarness(script,env,cwd) {
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['--import',import.meta.resolve('tsx'),script],{cwd,env:{PATH:process.env.PATH,...env},stdio:['ignore','pipe','pipe']})
    let output='',errors=''
    const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('Fixture harness timeout'))},15000)
    child.stdout.on('data',chunk=>{output+=chunk;if(output.length>64000)child.kill('SIGKILL')})
    child.stderr.on('data',chunk=>{errors+=chunk;if(errors.length>64000)child.kill('SIGKILL')})
    child.once('error',reject)
    child.once('close',code=>{clearTimeout(timer);if(code===0)resolve(JSON.parse(output));else reject(Error('Fixture harness failed: '+errors))})
  })
}

for(const origin of ['external','builtin'])test(origin+' harness queries once, computes frozen data and commits durable artifacts through the unified API',{
  skip:origin==='builtin'&&(process.env.DYOFFICE_TEST_CODEX_CLI!=='1'||!process.env.DYOFFICE_TEST_ANALYSIS_PYTHON),timeout:65000,
},async t=>{
  let queries=0
  const sourceServer=createServer((_request,response)=>{
    queries++;response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({rows:[{amount:10},{amount:20},{amount:30}]}))
  })
  await new Promise(resolve=>sourceServer.listen(0,'127.0.0.1',resolve))
  t.after(()=>{sourceServer.closeAllConnections();return new Promise(resolve=>sourceServer.close(resolve))})
  const endpoint='http://127.0.0.1:'+sourceServer.address().port+'/rows?credential=private-fixture-key'
  const f=await restrictedFixture(t,{businessMax:6})
  const sources=createSourceService({transactions:f.transactions,credentialKeys:'test:'+randomBytes(32).toString('base64'),egressTargets:[{kind:'http',endpoint,addresses:['127.0.0.1'],allowInsecure:true}]})
  const results=createWorkspaceSourceResults({transactions:f.transactions})
  const tools=createWorkspaceSourceTools({sources,results})
  const objectDir=await mkdtemp(join(tmpdir(),'office-harness-objects-'))
  t.after(()=>rm(objectDir,{recursive:true,force:true}))
  const objects=await createLocalObjectStore({directory:objectDir}),artifacts=createHarnessArtifacts({transactions:f.transactions,objects})
  const data=createHarnessDataAccess({tools,results,sessions:f.sessions,artifacts})
  const app=Fastify();registerHarnessDataRoutes(app,data)
  await app.listen({host:'127.0.0.1',port:0});t.after(()=>app.close())
  await sources.create(f.alice.token,{sourceId:'metrics',name:'Metrics',kind:'http',config:{timezone:'UTC',rowPath:'rows',units:{amount:'CNY'}},secret:endpoint})
  const grant=await data.issue({token:f.alice.token,agentId:origin+'-fixture',inputs:{sourceIds:['metrics'],resultIds:[]},signal:new AbortController().signal})
  const bob=await data.issue({token:f.bob.token,agentId:'peer',inputs:{sourceIds:[],resultIds:[]},signal:new AbortController().signal})
  assert.doesNotMatch(JSON.stringify(grant),/private-fixture-key|credential=|https?:/)
  assert.equal(queries,0,'Grant authorization must not execute a source query')
  const address=app.server.address(),baseUrl='http://127.0.0.1:'+address.port+'/api/v1/agents'
  const scratch=await mkdtemp(join(tmpdir(),'office-external-fixture-'));t.after(()=>rm(scratch,{recursive:true,force:true}))
  const script=join(scratch,'harness.mts'),clientModule=pathToFileURL(join(root,'packages/cli/src/harness-data.ts')).href
  await writeFile(script,`
import {readFile,writeFile} from 'node:fs/promises'
import {createHash,randomUUID} from 'node:crypto'
import {createHarnessDataClient} from ${JSON.stringify(clientModule)}
const client=createHarnessDataClient({baseUrl:process.env.HARNESS_BASE_URL,taskId:process.env.HARNESS_TASK_ID,credential:process.env.HARNESS_TASK_TOKEN})
const query=await client.execute('sources.query',{sourceId:'metrics'})
if('preview' in query||'rows' in query)throw Error('Data leaked into metadata')
await client.download(query.artifact.resultId,'input.json')
await client.download(query.artifact.resultId,'input-retry.json')
if(!(await readFile('input.json')).equals(await readFile('input-retry.json')))throw Error('Frozen retry changed input bytes')
const snapshot=JSON.parse(await readFile('input.json','utf8'))
if(snapshot.truncated)throw Error('Cannot claim a full-dataset total from truncated input')
const total=snapshot.rows.reduce((sum,row)=>sum+row.amount,0)
const report='Total '+total+' CNY across '+snapshot.rows.length+' rows.'
const chart='<svg xmlns="http://www.w3.org/2000/svg" width="200" height="40"><rect width="'+total+'" height="20"/><text x="0" y="36">'+total+' CNY</text></svg>'
await writeFile('report.txt',report);await writeFile('chart.svg',chart)
const inputRef=Object.fromEntries(['resultId','sha256','sourceId','sourceVersion','queryHash','rowCount','truncated'].map(key=>[key,query.artifact[key]]))
const staged=[]
for(const [name,mediaType,role] of [['report.txt','text/plain','report'],['chart.svg','image/svg+xml','chart'],['harness.mts','text/plain','code']]) {
 const bytes=await readFile(name),sha256=createHash('sha256').update(bytes).digest('hex')
 staged.push(await client.execute('artifacts.stage',{name,mediaType,role,inputResultIds:[query.artifact.resultId],sha256,bytesBase64:bytes.toString('base64')}))
}
const receipt=await client.execute('artifacts.commit',{commandId:randomUUID(),summary:report,artifactIds:staged.map(item=>item.artifactId),inputs:[inputRef],runtimeManifestSha256:'a'.repeat(64),limitations:['Deterministic Node fixture harness; model inference tested separately.']})
console.log(JSON.stringify({total,resultId:query.artifact.resultId,commandId:receipt.commandId,artifacts:receipt.artifacts.map(item=>({artifactId:item.artifactId,role:item.role})),summary:receipt.summary}))
`)
  let outcome
  if(origin==='external')outcome=await runHarness(script,{HARNESS_BASE_URL:baseUrl,HARNESS_TASK_ID:grant.taskId,HARNESS_TASK_TOKEN:grant.credential},scratch)
  else {
    const {createHarnessDataMailbox}=await import('../../server/src/modules/coding/data-mailbox.ts')
    const mailbox=await createHarnessDataMailbox(app,grant.taskId)
    t.after(()=>mailbox.close())
    const python=process.env.DYOFFICE_TEST_ANALYSIS_PYTHON
    const helper=join(root,'.dyoffice-analysis-build/harness-data.mjs')
    const analysis=[
      'import os, json, subprocess, hashlib, base64, uuid',
      'from pathlib import Path',
      'import pandas as pd, duckdb',
      'import matplotlib.pyplot as plt',
      'helper='+JSON.stringify([process.execPath,helper]),
      'def command(*args):',
      '    return json.loads(subprocess.check_output(helper+list(args),text=True))["detail"]',
      'def execute(operation,args):',
      '    Path("request.json").write_text(json.dumps(args))',
      '    return command("execute",operation,"--args-file","request.json")',
      'query=execute("sources.query",{"sourceId":"metrics"})',
      'assert "rows" not in query and "preview" not in query',
      'command("download",query["artifact"]["resultId"],"--out","input.json")',
      'command("download",query["artifact"]["resultId"],"--out","input-retry.json")',
      'assert Path("input.json").read_bytes()==Path("input-retry.json").read_bytes()',
      'snapshot=json.loads(Path("input.json").read_text())',
      'assert not snapshot["truncated"]',
      'df=pd.DataFrame(snapshot["rows"])',
      'total=duckdb.sql("select sum(amount) from df").fetchone()[0]',
      'assert total==60',
      'report=f"Total {total} CNY across {len(df)} rows."',
      'Path("report.txt").write_text(report)',
      'plt.bar(range(len(df)),df.amount);plt.savefig("chart.png");plt.close()',
      'assert Path("chart.png").read_bytes().startswith(bytes([137,80,78,71,13,10,26,10]))',
      'keys=["resultId","sha256","sourceId","sourceVersion","queryHash","rowCount","truncated"]',
      'inputRef={key:query["artifact"][key] for key in keys}',
      'staged=[]',
      'for name,media,role in [("report.txt","text/plain","report"),("chart.png","image/png","chart"),("analysis.py","text/x-python","code")]:',
      '    raw=Path(name).read_bytes()',
      '    staged.append(execute("artifacts.stage",{"name":name,"mediaType":media,"role":role,"inputResultIds":[query["artifact"]["resultId"]],"sha256":hashlib.sha256(raw).hexdigest(),"bytesBase64":base64.b64encode(raw).decode()}))',
      'receipt=execute("artifacts.commit",{"commandId":str(uuid.uuid4()),"summary":report,"artifactIds":[item["artifactId"] for item in staged],"inputs":[inputRef],"runtimeManifestSha256":os.environ["OFFICE_ANALYSIS_RUNTIME_MANIFEST_SHA256"],"limitations":["Real Codex sandbox and offline Python; deterministic model fixture, not upstream model validation."]})',
      'assert len(receipt["artifacts"])==3',
    ].join('\n')
    const cmd="cat > analysis.py <<'PY'\n"+analysis+"\nPY\n'"+python.replaceAll("'","'\\''")+"' analysis.py"
    let rounds=0,lastToolOutput=''
    const controller=new AbortController()
    const bridge=await createCodingModelBridge({token:'deterministic-office-model-session',modelId:'office-selected',signal:controller.signal,turns:{async run(input,emit){
      rounds++
      if(rounds===1)await emit({type:'tool_call',id:'call_data_analysis',name:'exec_command',input:{cmd,max_output_tokens:200}})
      else {lastToolOutput=JSON.stringify(input.request.messages.at(-1));await emit({type:'delta',text:'Analysis completed; the report, chart and executed code are committed.'})}
    }}})
    try {
      const result=await createCodingHarness({timeoutMs:55000,analysisPython:python}).run({instruction:'Analyze the authorized metrics source and submit report, chart and executed code.'},controller.signal,{baseUrl:bridge.baseUrl,apiKey:bridge.apiKey,modelId:'office-selected'},{baseUrl,grant,mailboxDirectory:mailbox.directory})
      assert.equal(rounds,2);assert.equal(result.output,'','Data tasks must not collect snapshots or upload payloads into Office model output')
      const committed=await data.delivery(grant.taskId,grant.credential)
      assert.ok(committed,'No delivery after shell execution: '+lastToolOutput)
      outcome={total:60,resultId:committed.inputs[0].resultId,commandId:committed.commandId}
    } finally {controller.abort();await bridge.close()}
  }
  assert.equal(outcome.total,60);assert.equal(queries,1)
  const receipt=await data.delivery(grant.taskId,grant.credential)
  assert.equal(receipt.commandId,outcome.commandId);assert.equal(receipt.summary,'Total 60 CNY across 3 rows.')
  assert.equal(receipt.artifacts.length,3);assert.equal(receipt.inputs[0].resultId,outcome.resultId)
  // A separate restarted harness process recovers the committed receipt after
  // the input expires. This exercises the real HTTP client/route and PG/RLS,
  // not only direct access-service calls; it must never requery or recommit.
  const recoveryScript=join(scratch,'recover.mts'),commandModule=pathToFileURL(join(root,'packages/cli/src/harness-data-command.ts')).href,argsModule=pathToFileURL(join(root,'packages/cli/src/args.ts')).href
  await writeFile(recoveryScript,`
import assert from 'node:assert/strict'
import {createHarnessDataClient} from ${JSON.stringify(clientModule)}
const client=createHarnessDataClient({baseUrl:process.env.HARNESS_BASE_URL,taskId:process.env.HARNESS_TASK_ID,credential:process.env.HARNESS_TASK_TOKEN})
import {runHarnessDataCommand} from ${JSON.stringify(commandModule)}
import {parseArgs} from ${JSON.stringify(argsModule)}
const recover=async()=>(await runHarnessDataCommand(parseArgs(['receipt',process.env.HARNESS_COMMAND_ID]),{cwd:process.cwd(),env:{OFFICE_HARNESS_DATA_URL:process.env.HARNESS_BASE_URL,OFFICE_HARNESS_TASK_ID:process.env.HARNESS_TASK_ID,OFFICE_HARNESS_DATA_CREDENTIAL:process.env.HARNESS_TASK_TOKEN}})).detail
if(process.env.HARNESS_EXPECT_DENIED==='1') {
 await assert.rejects(recover)
 console.log(JSON.stringify({denied:true}))
} else {
 const receipt=await recover()
 await assert.rejects(()=>client.manifest(process.env.HARNESS_RESULT_ID))
 console.log(JSON.stringify({commandId:receipt.commandId,summary:receipt.summary,artifactIds:receipt.artifacts.map(item=>item.artifactId)}))
}
`)
  const owner=await f.ownerPool.connect()
  try {
    await owner.query('BEGIN')
    await owner.query("SELECT set_config('dyoffice.deployment_id',$1,true),set_config('dyoffice.user_id',$2,true)",[f.deploymentId,f.alice.user.id])
    const changed=await owner.query("UPDATE workspace_source_results SET expires_at=now()-interval '1 second' WHERE result_id=$1",[outcome.resultId])
    assert.equal(changed.rowCount,1)
    await owner.query('COMMIT')
  } catch(error) {await owner.query('ROLLBACK');throw error} finally {owner.release()}
  const recoverWith=(task,denied=false)=>runHarness(recoveryScript,{HARNESS_BASE_URL:baseUrl,HARNESS_TASK_ID:task.taskId,HARNESS_TASK_TOKEN:task.credential,HARNESS_COMMAND_ID:outcome.commandId,HARNESS_RESULT_ID:outcome.resultId,HARNESS_EXPECT_DENIED:denied?'1':'0'},scratch)
  const recovered=await recoverWith(grant)
  assert.equal(recovered.commandId,receipt.commandId)
  assert.equal(recovered.summary,receipt.summary)
  assert.deepEqual(recovered.artifactIds,receipt.artifacts.map(item=>item.artifactId))
  assert.equal(queries,1,'Restarted receipt recovery must not rerun the source')
  const deliveryCount=await f.transactions.withPrincipalTransaction({kind:'session',token:f.alice.token},async c=>c.query('SELECT count(*)::int AS count FROM harness_analysis_deliveries'))
  assert.equal(deliveryCount.rows[0].count,1,'Restarted receipt recovery must not duplicate commit')
  const forged=await fetch(baseUrl+'/tasks/'+bob.taskId+'/data/execute',{method:'POST',headers:{authorization:'Bearer '+grant.credential,'content-type':'application/json'},body:JSON.stringify({operation:'sources.list',arguments:{}})})
  assert.equal(forged.status,403)
  const otherTask=await data.issue({token:f.alice.token,agentId:'same-owner-peer',inputs:{sourceIds:[],resultIds:[]},signal:new AbortController().signal})
  for(const peer of [bob,otherTask]) {
    assert.deepEqual(await recoverWith(peer,true),{denied:true},'Recovery denies cross-owner and same-owner other task')
    const guessed=await fetch(baseUrl+'/tasks/'+peer.taskId+'/data/results/'+outcome.resultId+'/content',{headers:{authorization:'Bearer '+peer.credential}})
    assert.equal(guessed.status,403,'Result IDs grant neither cross-owner nor same-owner cross-task access')
  }
  await assert.rejects(artifacts.receipt(f.bob.token,outcome.commandId))
  data.revoke(grant.taskId)
  assert.deepEqual(await recoverWith(grant,true),{denied:true},'Revoked task cannot recover even a committed receipt')
  const revoked=await fetch(baseUrl+'/tasks/'+grant.taskId+'/data/results/'+outcome.resultId+'/content',{headers:{authorization:'Bearer '+grant.credential}})
  assert.equal(revoked.status,403)
  await rm(scratch,{recursive:true,force:true})
  const stored=await artifacts.receipt(f.alice.token,outcome.commandId)
  assert.equal(stored.commandId,outcome.commandId)
  const reportArtifact=stored.artifacts.find(item=>item.role==='report'),chartArtifact=stored.artifacts.find(item=>item.role==='chart')
  assert.equal((await artifacts.download(f.alice.token,reportArtifact.artifactId)).bytes.toString(),'Total 60 CNY across 3 rows.')
  const chartBytes=(await artifacts.download(f.alice.token,chartArtifact.artifactId)).bytes
  if(origin==='external')assert.match(chartBytes.toString(),/<text[^>]*>60 CNY/)
  else assert.deepEqual(chartBytes.subarray(0,8),Buffer.from([137,80,78,71,13,10,26,10]))
  await assert.rejects(artifacts.download(f.bob.token,reportArtifact.artifactId))
  assert.equal(queries,1,'Frozen download and artifact reads must never re-run the connector query')
})
