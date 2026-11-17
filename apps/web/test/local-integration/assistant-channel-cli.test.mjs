import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {fileFixture,docxBytes,importFile} from '../helpers/files.mjs'
import {createAssistantChannelService} from '../../server/src/modules/assistant-channel/service.ts'
import {agentCommand} from '../../../../packages/cli/src/commands/agent.ts'
import {parseArgs} from '../../../../packages/cli/src/args.ts'

// These are real TCP requests against the production routes and restricted PostgreSQL service.
test('CLI joins and runs a task through real HTTP; reconnect/revoke fence old claims',async t=>{
 const f=await fileFixture(t,{assistantChannels:true}),directory=await mkdtemp(join(tmpdir(),'channel-cli-'))
 t.after(()=>rm(directory,{recursive:true,force:true}))
 const file=(await importFile(f,f.alice.token,await docxBytes())).file
 const service=createAssistantChannelService({transactions:f.transactions,credentialKey:f.csrfKey})
 const channel=await service.createConversation(f.alice.token,{fileId:file.fileId})
 await f.app.listen({host:'127.0.0.1',port:0})
 const origin=`http://127.0.0.1:${f.app.server.address().port}`
 const stateFile=join(directory,'channel.json'),inviteFile=join(directory,'invite'),adapterFile=join(directory,'adapter.json')
 const ctx={cwd:directory,env:{PATH:process.env.PATH},log(){},warn(){}}
 const invoke=(operation,...args)=>agentCommand.run(parseArgs([operation,'--state-file',stateFile,...args]),ctx)
 const invite=await service.invite(f.alice.token,channel.conversationId)
 await writeFile(inviteFile,invite.inviteToken,{mode:0o600})
 const application=await invoke('join','--origin',origin,'--invite-file',inviteFile,'--name','CLI Harness','--kind','custom')
 assert.equal((await invoke('status')).detail.state,'pending')
 await service.approve(f.alice.token,channel.conversationId,application.detail.applicationId,{approved:true})
 await invoke('redeem');await invoke('connect')
 let state=JSON.parse(await readFile(stateFile,'utf8'))
 assert.match(state.connectionId,/^[0-9a-f-]{36}$/)
 const owner={kind:'owner',token:f.alice.token}
 const submit=action=>service.submit(owner,{requestId:randomUUID(),conversationId:channel.conversationId,to:state.memberId,action})
 const task=await submit({kind:'delegate',instruction:'Real HTTP and PG execution'})
 await writeFile(adapterFile,JSON.stringify({command:process.execPath,args:['-e',"process.stdin.on('data',d=>process.stdout.write(JSON.stringify({summary:JSON.parse(d).task.instruction,outcome:'succeeded'})))"]}))
 await invoke('run','--task',task.taskId,'--adapter-file',adapterFile)
 assert.equal((await invoke('task','--task',task.taskId)).detail.state,'succeeded')
 const pending=await submit({kind:'delegate',instruction:'Must not rerun stale claim'})
 const credential={kind:'member',token:state.memberToken}
 const claim=await service.claim(credential,channel.conversationId,{taskId:pending.taskId,connectionId:state.connectionId,connectionEpoch:state.connectionEpoch})
 await invoke('connect');state=JSON.parse(await readFile(stateFile,'utf8'))
 assert.equal((await invoke('task','--task',pending.taskId)).detail.state,'unknown_outcome')
 await assert.rejects(invoke('run','--task',pending.taskId,'--adapter-file',adapterFile),/409/)
 await service.revoke(f.alice.token,channel.conversationId,state.memberId)
 await assert.rejects(invoke('tasks'),/401/)
 await assert.rejects(service.submit(credential,{requestId:randomUUID(),conversationId:channel.conversationId,to:'office',action:{kind:'result',taskId:claim.taskId,claimId:claim.claimId,connectionEpoch:claim.connectionEpoch,summary:'late',outcome:'succeeded'}}),{statusCode:401})
})

test('watch observes durable cancellation, kills its process group and leaves an unknown outcome for review',async t=>{
 const {watchChannel}=await import('../../../../packages/cli/src/agent-channel/connector.ts')
 const {ChannelClient}=await import('../../../../packages/cli/src/agent-channel/client.ts')
 const {watch}=await import('node:fs')
 const f=await fileFixture(t,{assistantChannels:true}),directory=await mkdtemp(join(tmpdir(),'channel-watch-'))
 t.after(()=>rm(directory,{recursive:true,force:true}))
 const file=(await importFile(f,f.alice.token,await docxBytes())).file
 const service=createAssistantChannelService({transactions:f.transactions,credentialKey:f.csrfKey})
 const channel=await service.createConversation(f.alice.token,{fileId:file.fileId})
 const invitation=await service.invite(f.alice.token,channel.conversationId)
 const application=await service.apply(invitation.inviteToken,{displayName:'Watcher',kind:'custom'})
 await service.approve(f.alice.token,channel.conversationId,application.applicationId,{approved:true})
 const member=await service.redeem(application.applicationToken),memberId=member.member.membershipId
 const task=await service.submit({kind:'owner',token:f.alice.token},{requestId:randomUUID(),conversationId:channel.conversationId,to:memberId,action:{kind:'delegate',instruction:'Wait for cancellation'}})
 await f.app.listen({host:'127.0.0.1',port:0})
 const origin=`http://127.0.0.1:${f.app.server.address().port}`,marker=join(directory,'adapter.pid')
 const started=new Promise(resolve=>{const watcher=watch(directory,()=>{watcher.close();resolve()})})
 const controller=new AbortController()
 const watching=watchChannel({client:new ChannelClient(origin),state:{origin,memberId,memberToken:member.memberToken,conversationId:channel.conversationId},adapter:{command:process.execPath,args:['-e',"require('node:fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)",marker]},env:{},signal:controller.signal,save:async()=>{}})
 t.after(()=>controller.abort())
 await started
 const pid=Number(await readFile(marker,'utf8'))
 await service.submit({kind:'owner',token:f.alice.token},{requestId:randomUUID(),conversationId:channel.conversationId,to:memberId,action:{kind:'cancel',taskId:task.taskId}})
 await watching
 assert.throws(()=>process.kill(pid,0))
 assert.equal((await service.memberSnapshot(member.memberToken)).tasks[0].state,'unknown_outcome')
})
