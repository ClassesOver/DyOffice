import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp, writeFile, readdir, rm, readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createCodingHarness} from '../../server/src/modules/coding/harness.ts'

const model={baseUrl:'http://127.0.0.1:12345/v1',apiKey:'task-local-token',modelId:'office'}
async function fixture(t,body) {
 const root=await mkdtemp(join(tmpdir(),'office-harness-test-'))
 t.after(()=>rm(root,{recursive:true,force:true}))
 const cli=join(root,'codex')
 await writeFile(cli,'#!/usr/bin/env node\n'+body,{mode:0o700})
 return {root,cli}
}
test('launches lazily in an isolated workspace, returns coding output and removes workspace',async t=>{
 const f=await fixture(t,`const fs=require('fs'); const args=process.argv.slice(2);
 if(!args.includes('--ignore-user-config')||!args.includes('--ephemeral')||args.includes('--sandbox')||!args.includes('--strict-config')||!args.includes('default_permissions="office_coding"')||!args.some(x=>x.startsWith('permissions.office_coding.filesystem=')&&x.includes(':minimal')))process.exit(3);
 let input='';process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{
 fs.writeFileSync('answer.py','print(42)');
 console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Implemented and tested'}}));
 console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:2}}));});`)
 const harness=createCodingHarness({cliPath:f.cli,workspaceRoot:f.root})
 assert.deepEqual((await readdir(f.root)).sort(),['codex'])
 const result=await harness.run({instruction:'write code',context:'numbers'},new AbortController().signal,model)
 assert.equal(result.summary,'Implemented and tested')
 assert.match(result.output,/answer.py/)
 assert.match(result.output,/print\(42\)/)
 assert.deepEqual((await readdir(f.root)).sort(),['codex'])
})
test('process failure is contained and removes the temporary workspace',async t=>{
 const f=await fixture(t,`process.stdin.resume();process.stdin.on('end',()=>process.exit(2));`)
 const harness=createCodingHarness({cliPath:f.cli,workspaceRoot:f.root})
 await assert.rejects(harness.run({instruction:'fail'},new AbortController().signal,model),/Codex/)
 assert.deepEqual((await readdir(f.root)).sort(),['codex'])
})
test('aborting a coding task terminates its child and releases capacity',async t=>{
 const f=await fixture(t,'process.stdin.resume();setInterval(()=>{},1000)')
 const harness=createCodingHarness({cliPath:f.cli,workspaceRoot:f.root,timeoutMs:5000})
 const controller=new AbortController()
 const pending=harness.run({instruction:'wait'},controller.signal,model)
 setTimeout(()=>controller.abort(),80)
 await assert.rejects(pending,e=>e.name==='AbortError')
 assert.deepEqual((await readdir(f.root)).sort(),['codex'])
})
test('does not follow symlinks in generated outputs',async t=>{
 const f=await fixture(t,`const fs=require('fs');process.stdin.resume();process.stdin.on('end',()=>{fs.symlinkSync('/etc/passwd','leak');console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'done'}}));console.log(JSON.stringify({type:'turn.completed'}));});`)
 const result=await createCodingHarness({cliPath:f.cli,workspaceRoot:f.root}).run({instruction:'code'},new AbortController().signal,model)
 assert.doesNotMatch(result.output,/root:|leak/)
})

test('cancellation terminates a stubborn grandchild holding inherited stdout',async t=>{
 const f=await fixture(t,`const {spawn}=require('child_process');
 process.stdin.resume();const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:['ignore',1,2]});
 require('fs').writeFileSync('ready.pid',String(child.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`)
 const controller=new AbortController()
 const pending=createCodingHarness({cliPath:f.cli,workspaceRoot:f.root,timeoutMs:5000}).run({instruction:'wait'},controller.signal,model)
 let ready=false
 for(let i=0;i<100;i++) {
  const dirs=(await readdir(f.root)).filter(x=>x.startsWith('office-coding-'))
  if(dirs.length)try{await readFile(join(f.root,dirs[0],'ready.pid'));ready=true;break}catch{}
  await new Promise(resolve=>setTimeout(resolve,10))
 }
 assert.equal(ready,true);controller.abort()
 await assert.rejects(pending,e=>e.name==='AbortError')
 assert.deepEqual((await readdir(f.root)).sort(),['codex'])
})

test('data tasks expose only their grant and runtime hash, never collect raw snapshots or upload payloads',async t=>{
 const f=await fixture(t,`const fs=require('fs');const args=process.argv.slice(2);
 const settings=args.find(x=>x.startsWith('shell_environment_policy.set='));
 if(args.some(x=>x.includes('secret-in-env'))||!settings.includes('OFFICE_HARNESS_DATA_CREDENTIAL_FILE')||fs.readFileSync('.office-data-credential','utf8')!=='secret-in-env')process.exit(4);
 let prompt='';process.stdin.on('data',x=>prompt+=x);process.stdin.on('end',()=>{
 if(!prompt.includes('Allowed inputs:')||!prompt.includes('receipt <commandId>')||!prompt.includes('do not requery or repeat artifacts.commit')||prompt.includes('secret-in-env'))process.exit(5);
 fs.writeFileSync('snapshot.json','{"rows":[{"secret":"raw-data-must-stay-local"}]}');
 fs.writeFileSync('stage.json','{"bytesBase64":"private-upload-payload"}');
 console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Analysis completed with committed artifacts.'}}));console.log(JSON.stringify({type:'turn.completed'}));});`)
 const helper=join(f.root,'helper.mjs');await writeFile(helper,'// trusted helper')
 const data={baseUrl:'http://127.0.0.1/api/v1/agents',grant:{taskId:'task_1',credential:'secret-in-env',inputs:{sourceIds:['sales'],resultIds:[]}}}
 const result=await createCodingHarness({cliPath:f.cli,workspaceRoot:f.root,dataHelper:helper}).run({instruction:'analyze',dataInputs:data.grant.inputs},new AbortController().signal,model,data)
 assert.equal(result.output,'');assert.match(result.summary,/committed artifacts/)
})
