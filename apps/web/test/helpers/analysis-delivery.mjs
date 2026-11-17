// Synthetic adapter for authorized, local integration/browser fixtures only.
// Uses the same task bearer, artifact staging and commit routes as a harness;
// does not invoke Codex, a model, a shell or any external data source.
import assert from 'node:assert/strict'
import {Readable} from 'node:stream'
import {createHash,randomUUID} from 'node:crypto'
export function syntheticAnalysisAdapter(getApp,{text='Analysis literal <script>not executable</script>',name='analysis.txt',mediaType='text/plain',role='report'}={}) {
 const bytes=Buffer.from(text),sha256=createHash('sha256').update(bytes).digest('hex')
 let runs=0,committed
 return {
  descriptor:{id:'analysis_fixture',name:'Synthetic analysis fixture',origin:'external',capabilities:['coding']},
  get runs(){return runs},get committed(){return committed},
  async run(_input,signal,context){
   assert.equal(signal.aborted,false);assert.ok(context?.data?.grant)
   const grant=context.data.grant
   const execute=async(operation,args)=>{
    const response=await getApp().inject({method:'POST',url:`/api/v1/agents/tasks/${grant.taskId}/data/execute`,headers:{authorization:`Bearer ${grant.credential}`},payload:{operation,arguments:args}})
    assert.equal(response.statusCode,200,`${operation}: ${response.body}`)
    return response.json()
   }
   const artifact=await execute('artifacts.stage',{name,mediaType,role,inputResultIds:[],sha256,bytesBase64:bytes.toString('base64')})
   committed=await execute('artifacts.commit',{commandId:randomUUID(),summary:'Synthetic literal content; not a real model result',artifactIds:[artifact.artifactId],inputs:[],runtimeManifestSha256:createHash('sha256').update('local-fixture-only').digest('hex'),limitations:['Synthetic fixture; no source query or upstream model']})
   runs++
   return {summary:'Synthetic delivery committed',output:'The artifact is not inserted or saved in the document.'}
  },
 }
}
/** A deterministic two-turn Office provider response: delegate once, then stop.
 * mockProviderNetwork intercepts these bytes before any external connection. */
export function syntheticAnalysisFrames(){
 let turn=0
 return ()=>{
  const data=turn++===0?{choices:[{delta:{tool_calls:[{index:0,id:'fixture_call',type:'function',function:{name:'delegate_agent_task',arguments:JSON.stringify({instruction:'Produce the synthetic analysis fixture',agentId:'analysis_fixture',dataInputs:{sourceIds:[],resultIds:[]}})}}]},finish_reason:'tool_calls'}]}:{choices:[{delta:{content:'Synthetic artifact ready. Insert and save are separate user actions.'},finish_reason:'stop'}]}
  return Readable.from([Buffer.from('data: '+JSON.stringify(data)+'\n\n'),Buffer.from('data: [DONE]\n\n')])
 }
}
