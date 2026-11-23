import test from 'node:test'
import assert from 'node:assert/strict'
import {createCodingHarness} from '../../server/src/modules/coding/harness.ts'
import {createCodingModelBridge} from '../../server/src/modules/coding/model-bridge.ts'

// Real installed Codex and real sandbox; model output is deterministic and free.
test('installed Codex executes code through the Office model bridge without its own login',{
 skip:process.env.DYOFFICE_TEST_CODEX_CLI!=='1',timeout:35000,
},async()=>{
 let rounds=0
 const controller=new AbortController()
 const bridge=await createCodingModelBridge({token:'synthetic-office-session',modelId:'office-selected',signal:controller.signal,turns:{async run(input,emit){
  assert.equal(input.token,'synthetic-office-session');assert.equal(input.modelId,'office-selected');rounds++
  if(rounds===1)await emit({type:'tool_call',id:'call_verify',name:'exec_command',input:{cmd:"python3 -c \"from pathlib import Path; assert 2+3==5; Path('verified.txt').write_text('python assertion passed')\"",max_output_tokens:100}})
  else await emit({type:'delta',text:'Implemented and tested with the Office-selected model.'})
  await emit({type:'usage',inputTokens:120,outputTokens:30})
 }}})
 try {
  const result=await createCodingHarness({timeoutMs:30000}).run({instruction:'Write code and test it in the provided directory.'},controller.signal,{baseUrl:bridge.baseUrl,apiKey:bridge.apiKey,modelId:'office-selected'})
  assert.equal(rounds,2);assert.match(result.output,/python assertion passed/)
 }finally{controller.abort();await bridge.close()}
})

test('installed Codex can use the read-only offline analysis runtime inside its sandbox',{
 skip:!process.env.DYOFFICE_TEST_ANALYSIS_PYTHON,timeout:45000,
},async()=>{
 const python=process.env.DYOFFICE_TEST_ANALYSIS_PYTHON
 const script=[
  'import json, os, sys',
  'from pathlib import Path',
  'import pandas as pd, duckdb, scipy.stats as stats',
  'import matplotlib.pyplot as plt',
  "assert os.environ['PIP_NO_INDEX']=='1' and os.environ['UV_OFFLINE']=='1'",
  "probe=Path(sys.prefix)/'office-readonly-probe'",
  'try: probe.write_text("must not write shared runtime")',
  'except OSError: pass',
  'else:',
  '    probe.unlink();raise AssertionError("Shared analysis runtime was writable")',
  "df=pd.DataFrame({'value':[1,2,3]})",
  "assert duckdb.sql('select sum(value) from df').fetchone()[0]==6",
  'assert stats.ttest_1samp([1,2,3],2).statistic==0',
  "df.to_parquet('data.parquet');assert pd.read_parquet('data.parquet').equals(df)",
  "plt.plot(df.value);plt.savefig('chart.png');plt.close()",
  "Path('analysis.json').write_text(json.dumps({'total':6,'chartBytes':Path('chart.png').stat().st_size}))",
 ].join('\n')
 let rounds=0,lastToolOutput=''
 const controller=new AbortController()
 const bridge=await createCodingModelBridge({token:'synthetic-session',modelId:'office-selected',signal:controller.signal,turns:{async run(input,emit){
  rounds++
  if(rounds>1)lastToolOutput=JSON.stringify(input.request.messages.at(-1))
  if(rounds===1)await emit({type:'tool_call',id:'call_analysis',name:'exec_command',input:{cmd:"'"+python.replaceAll("'","'\\''")+"' - <<'PY'\n"+script+'\nPY',max_output_tokens:100}})
  else await emit({type:'delta',text:'Offline SQL, statistics and chart completed.'})
 }}})
 try {
  const result=await createCodingHarness({timeoutMs:40000,analysisPython:python}).run({instruction:'Analyze local data using the offline environment.'},controller.signal,{baseUrl:bridge.baseUrl,apiKey:bridge.apiKey,modelId:'office-selected'})
  assert.equal(rounds,2);assert.match(result.output,/"total": 6/,lastToolOutput);assert.match(result.output,/"chartBytes": [1-9][0-9]+/)
 }finally{controller.abort();await bridge.close()}
})

test('installed Codex accesses the same task data API through a task mailbox with network denied',{
 skip:process.env.DYOFFICE_TEST_CODEX_CLI!=='1',timeout:35000,
},async t=>{
 const {createHarnessDataMailbox}=await import('../../server/src/modules/coding/data-mailbox.ts')
 const requests=[]
 const mailbox=await createHarnessDataMailbox({async inject(request){
  requests.push(request)
  return {statusCode:200,headers:{'content-type':'application/json'},rawPayload:Buffer.from(JSON.stringify({sources:[{id:'sales'}]}))}
 }},'task_1')
 t.after(()=>mailbox.close())
 const controller=new AbortController(),grant={taskId:'task_1',credential:'task-only-credential',inputs:{sourceIds:['sales'],resultIds:[]}}
 let rounds=0,lastToolOutput=''
 const bridge=await createCodingModelBridge({token:'synthetic-session',modelId:'office-selected',signal:controller.signal,turns:{async run(input,emit){
  rounds++
  if(rounds>1)lastToolOutput=JSON.stringify(input.request.messages.at(-1))
  if(rounds===1)await emit({type:'tool_call',id:'call_data',name:'exec_command',input:{cmd:JSON.stringify(process.execPath)+' '+JSON.stringify(new URL('../../../../.dyoffice-analysis-build/harness-data.mjs',import.meta.url).pathname)+' execute list_connections',max_output_tokens:200}})
  else await emit({type:'delta',text:'Data available over the task-local transport.'})
 }}})
 try {
  const result=await createCodingHarness({timeoutMs:30000}).run({instruction:'List authorized data sources.'},controller.signal,{baseUrl:bridge.baseUrl,apiKey:bridge.apiKey,modelId:'office-selected'},{baseUrl:'http://127.0.0.1/api/v1/agents',grant,mailboxDirectory:mailbox.directory})
  assert.equal(rounds,2);assert.equal(requests.length,1,lastToolOutput)
  assert.equal(requests[0].headers.authorization,'Bearer task-only-credential')
  assert.equal(requests[0].url,'/api/v1/agents/tasks/task_1/data/execute')
  assert.deepEqual(JSON.parse(requests[0].payload),{operation:'list_connections',arguments:{}})
  assert.equal(result.output,'');assert.match(result.summary,/Data available/)
 }finally{controller.abort();await bridge.close()}
})
