import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import {fileFixture,docxBytes,importFile} from '../helpers/files.mjs'
import {createAssistantChannelService} from '../../server/src/modules/assistant-channel/service.ts'
import {createCodingModelBridge} from '../../server/src/modules/coding/model-bridge.ts'
import {resolveCodexCliPath} from '../../../../packages/ai-provider/src/codex-app-server.ts'
import {agentCommand} from '../../../../packages/cli/src/commands/agent.ts'
import {parseArgs} from '../../../../packages/cli/src/args.ts'

// Real installed Codex, real restricted sandbox, real HTTP routes and PostgreSQL.
// Inference is an explicit deterministic fixture, with no upstream model or login.
// This source adapter is selected explicitly, not a packaged compatibility promise.
test('explicit source stdio adapter runs installed Codex Python and commits its channel result',{
 skip:process.env.DYOFFICE_TEST_CODEX_CLI!=='1',timeout:45000,
},async t=>{
 const f=await fileFixture(t,{assistantChannels:true}),directory=await mkdtemp(join(tmpdir(),'channel-codex-'))
 t.after(()=>rm(directory,{recursive:true,force:true}))
 const file=(await importFile(f,f.alice.token,await docxBytes())).file
 const service=createAssistantChannelService({transactions:f.transactions,credentialKey:f.csrfKey})
 const channel=await service.createConversation(f.alice.token,{fileId:file.fileId})
 await f.app.listen({host:'127.0.0.1',port:0})
 const origin=`http://127.0.0.1:${f.app.server.address().port}`
 const stateFile=join(directory,'channel.json'),inviteFile=join(directory,'invite'),adapterFile=join(directory,'adapter.json')
 const context={cwd:directory,env:{PATH:process.env.PATH},log(){},warn(){}}
 const invoke=(operation,...args)=>agentCommand.run(parseArgs([operation,'--state-file',stateFile,...args]),context)
 const invite=await service.invite(f.alice.token,channel.conversationId)
 await writeFile(inviteFile,invite.inviteToken,{mode:0o600})
 const application=await invoke('join','--origin',origin,'--invite-file',inviteFile,'--name','Explicit Codex source adapter','--kind','codex')
 await service.approve(f.alice.token,channel.conversationId,application.detail.applicationId,{approved:true})
 await invoke('redeem');await invoke('connect')
 const state=JSON.parse(await readFile(stateFile,'utf8'))
 const task=await service.submit({kind:'owner',token:f.alice.token},{requestId:randomUUID(),conversationId:channel.conversationId,to:state.memberId,action:{kind:'delegate',instruction:'Run a Python assertion in the restricted task directory and report the evidence.'}})
 let rounds=0,toolEvidence=''
 const controller=new AbortController()
 const bridge=await createCodingModelBridge({token:'deterministic-channel-model-session',modelId:'office-selected',signal:controller.signal,turns:{async run(input,emit){
  assert.equal(input.token,'deterministic-channel-model-session');assert.equal(input.modelId,'office-selected');rounds++
  if(rounds===1)await emit({type:'tool_call',id:'verify_channel_python',name:'exec_command',input:{cmd:"python3 -c \"from pathlib import Path; assert sum([2,3,5])==10; Path('verified.txt').write_text('channel python assertion passed'); print('channel python assertion passed')\"",max_output_tokens:100}})
  else {toolEvidence=JSON.stringify(input.request.messages.at(-1));await emit({type:'delta',text:'Python assertion executed successfully in the restricted channel task workspace.'})}
 }}})
 t.after(async()=>{controller.abort();await bridge.close()})
 const modelFile=join(directory,'model.json'),script=join(directory,'source-adapter.mts')
 await writeFile(modelFile,JSON.stringify({cliPath:await resolveCodexCliPath(),model:{baseUrl:bridge.baseUrl,apiKey:bridge.apiKey,modelId:'office-selected'}}),{mode:0o600})
 const harnessUrl=new URL('../../server/src/modules/coding/harness.ts',import.meta.url).href
 await writeFile(script,`import {readFile} from 'node:fs/promises';
import {createCodingHarness} from ${JSON.stringify(harnessUrl)};
let input='';for await(const chunk of process.stdin)input+=chunk;
const request=JSON.parse(input),config=JSON.parse(await readFile(process.argv[2],'utf8'));
const result=await createCodingHarness({cliPath:config.cliPath,timeoutMs:30000}).run({instruction:request.task.instruction},new AbortController().signal,config.model);
if(!result.output.includes('channel python assertion passed'))throw Error('Missing executed artifact evidence');
process.stdout.write(JSON.stringify({summary:result.output,outcome:'succeeded'}));
`,{mode:0o600})
 await writeFile(adapterFile,JSON.stringify({command:process.execPath,args:['--import',fileURLToPath(import.meta.resolve('tsx')),script,modelFile]}),{mode:0o600})
 await invoke('run','--task',task.taskId,'--adapter-file',adapterFile)
 const completed=(await invoke('task','--task',task.taskId)).detail
 assert.equal(completed.state,'succeeded');assert.equal(completed.outcome,'succeeded')
 assert.match(completed.summary,/channel python assertion passed/)
 assert.equal(rounds,2);assert.match(toolEvidence,/channel python assertion passed/)
})
