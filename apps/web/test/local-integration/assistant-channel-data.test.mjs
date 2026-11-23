import test from 'node:test'
import assert from 'node:assert/strict'
import {randomBytes,randomUUID,createHash} from 'node:crypto'
import {fileFixture,docxBytes,importFile} from '../helpers/files.mjs'
import {createSourceService} from '../../server/src/modules/sources/service.ts'
import {createWorkspaceSourceResults} from '../../server/src/modules/sources/results.ts'
import {createQuerySnapshot} from '../../server/src/modules/sources/provenance.ts'
import {createCsrfService} from '../../server/src/modules/auth/csrf.ts'
import {restrictedOrigin} from '../helpers/restricted.mjs'

test('approved channel member exchanges only its current claim for unified frozen-data access; cancellation fences existing grant',async t=>{
 const f=await fileFixture(t,{assistantChannels:true})
 const file=(await importFile(f,f.alice.token,await docxBytes())).file
 const sources=createSourceService({transactions:f.transactions,credentialKeys:'test:'+randomBytes(32).toString('base64')})
 const results=createWorkspaceSourceResults({transactions:f.transactions})
 await sources.create(f.alice.token,{sourceId:'metrics',name:'Metrics',kind:'http',config:{timezone:'UTC'},secret:'https://fixture.invalid/data'})
 const snapshot=createQuerySnapshot({sourceId:'metrics',sourceVersion:1,timezone:'UTC',schema:[{name:'amount',type:'number'}],rows:[{amount:42}],sourceTruncated:false})
 const frozen=await results.capture(f.alice.token,snapshot,createHash('sha256').update('channel fixture').digest('hex'),file.fileId)
 const csrf=createCsrfService({db:f.db,deploymentId:f.deploymentId,origin:restrictedOrigin,key:f.csrfKey})
 const ownerHeaders={origin:restrictedOrigin,cookie:'__Host-dyoffice-session='+f.alice.token,'x-csrf-token':csrf.sessionToken(f.alice.token)}
 const base='/api/v1/assistant-channels'
 const post=async(path,payload,headers=ownerHeaders)=>f.app.inject({method:'POST',url:base+path,payload,headers})
 const channel=(await post('/channels',{fileId:file.fileId})).json(),conversationId=channel.conversationId
 const invite=(await post('/channels/'+conversationId+'/invitations',{})).json()
 const application=(await post('/applications',{inviteToken:invite.inviteToken,name:'Analyst',kind:'custom'},{})).json()
 await post('/channels/'+conversationId+'/applications/'+application.applicationId+'/approve',{approved:true})
 const member=(await post('/applications/'+application.applicationId+'/redeem',{},{authorization:'Bearer '+application.applicationToken})).json()
 const headers={authorization:'Bearer '+member.memberToken},memberPath='/members/'+member.memberId,connectionId=randomUUID()
 const connected=(await post(memberPath+'/connect',{connectionId},headers)).json()
 const receipt=(await post('/actions',{requestId:randomUUID(),conversationId,to:member.memberId,action:{kind:'delegate',instruction:'Analyze',dataInputs:{sourceIds:[],resultIds:[frozen.resultId]}}})).json()
 const grantPath=memberPath+'/tasks/'+receipt.taskId+'/data-grant'
 assert.equal((await post(grantPath,{claimId:randomUUID(),connectionEpoch:connected.connectionEpoch},headers)).statusCode,403)
 const claimed=await post(memberPath+'/claim',{taskId:receipt.taskId,connectionId,...connected},headers)
 assert.equal(claimed.statusCode,200,claimed.body)
 const claim=claimed.json(),body={claimId:claim.claimId,connectionEpoch:claim.connectionEpoch}
 assert.equal((await post(grantPath,{...body,dataInputs:{sourceIds:['metrics'],resultIds:[]}},headers)).statusCode,400)
 const exchanged=await post(grantPath,body,headers)
 assert.equal(exchanged.statusCode,200,exchanged.body)
 const data=exchanged.json();assert.equal(data.baseUrl,restrictedOrigin+'/api/v1/agents')
 assert.doesNotMatch(JSON.stringify(data),new RegExp(f.alice.token));assert.ok(data.grant.credential)
 const endpoint='/api/v1/agents/tasks/'+data.grant.taskId+'/data'
 const dataHeaders={authorization:'Bearer '+data.grant.credential}
 const execute=(operation,args)=>f.app.inject({method:'POST',url:endpoint+'/execute',headers:dataHeaders,payload:{operation,arguments:args}})
 const manifest=await execute('results.get_manifest',{resultId:frozen.resultId})
 assert.equal(manifest.statusCode,200,manifest.body);assert.equal('rows' in manifest.json(),false)
 assert.equal((await execute('execute_sql',{sourceId:'metrics',sql:'SELECT 1'})).statusCode,403)
 const downloaded=await f.app.inject({url:endpoint+'/results/'+frozen.resultId+'/content',headers:dataHeaders})
 assert.equal(downloaded.statusCode,200,downloaded.body);assert.deepEqual(downloaded.json().rows,[{amount:42}])
 await post('/actions',{requestId:randomUUID(),conversationId,to:member.memberId,action:{kind:'cancel',taskId:claim.taskId}})
 assert.equal((await execute('results.get_manifest',{resultId:frozen.resultId})).statusCode,403)
 assert.equal((await post(grantPath,body,headers)).statusCode,403)
})

test('real CLI adapter downloads a frozen result, computes outside Office and commits an owner-readable report',async t=>{
 const {createServer}=await import('node:net')
 const {mkdtemp,writeFile,rm}=await import('node:fs/promises')
 const {tmpdir}=await import('node:os'),{join}=await import('node:path')
 const {createAssistantChannelService}=await import('../../server/src/modules/assistant-channel/service.ts')
 const {agentCommand}=await import('../../../../packages/cli/src/commands/agent.ts')
 const {parseArgs}=await import('../../../../packages/cli/src/args.ts')
 const {writeState}=await import('../../../../packages/cli/src/agent-channel/connector.ts')
 const reservation=createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve))
 const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve))
 const origin='http://127.0.0.1:'+port,f=await fileFixture(t,{origin,assistantChannels:true})
 await f.app.listen({host:'127.0.0.1',port})
 const file=(await importFile(f,f.alice.token,await docxBytes())).file
 const channels=createAssistantChannelService({transactions:f.transactions,credentialKey:f.csrfKey})
 const channel=await channels.createConversation(f.alice.token,{fileId:file.fileId}),id=channel.conversationId
 const invite=await channels.invite(f.alice.token,id),application=await channels.apply(invite.inviteToken,{displayName:'External data fixture',kind:'custom'})
 await channels.approve(f.alice.token,id,application.applicationId,{approved:true})
 const member=await channels.redeem(application.applicationToken),memberId=member.member.membershipId
 const sources=createSourceService({transactions:f.transactions,credentialKeys:'test:'+randomBytes(32).toString('base64')})
 const results=createWorkspaceSourceResults({transactions:f.transactions})
 await sources.create(f.alice.token,{sourceId:'metrics',name:'Metrics',kind:'http',config:{timezone:'UTC'},secret:'https://fixture.invalid/data'})
 const snapshot=createQuerySnapshot({sourceId:'metrics',sourceVersion:1,timezone:'UTC',schema:[{name:'amount',type:'number',unit:'CNY'}],rows:[{amount:10},{amount:20},{amount:30}],sourceTruncated:false})
 const frozen=await results.capture(f.alice.token,snapshot,createHash('sha256').update('CLI frozen fixture').digest('hex'),file.fileId)
 const receipt=await channels.submit({kind:'owner',token:f.alice.token},{requestId:randomUUID(),conversationId:id,to:memberId,action:{kind:'delegate',instruction:'Total the frozen input and commit a report',dataInputs:{sourceIds:[],resultIds:[frozen.resultId]}}})
 const directory=await mkdtemp(join(tmpdir(),'channel-data-cli-'));t.after(()=>rm(directory,{recursive:true,force:true}))
 const state=join(directory,'state.json'),adapter=join(directory,'adapter.json'),script=join(directory,'adapter.mts'),inputFile=join(directory,'input.json')
 await writeState(state,{origin,memberId,memberToken:member.memberToken,conversationId:id})
 const moduleUrl=new URL('../../../../packages/cli/src/harness-data.ts',import.meta.url).href
 await writeFile(script,`
import {readFile} from 'node:fs/promises'
import {createHash,randomUUID} from 'node:crypto'
import {createHarnessDataClient} from ${JSON.stringify(moduleUrl)}
let stdin='';for await(const chunk of process.stdin)stdin+=chunk
const {data}=JSON.parse(stdin),client=createHarnessDataClient({baseUrl:data.baseUrl,taskId:data.grant.taskId,credential:data.grant.credential})
const resultId=data.grant.inputs.resultIds[0],manifest=await client.manifest(resultId)
await client.download(resultId,${JSON.stringify(inputFile)})
const snapshot=JSON.parse(await readFile(${JSON.stringify(inputFile)},'utf8'))
if(snapshot.truncated)throw Error('Truncated input')
const total=snapshot.rows.reduce((sum,row)=>sum+row.amount,0),bytes=Buffer.from('Total '+total+' CNY')
const staged=await client.execute('artifacts.stage',{name:'report.txt',mediaType:'text/plain',role:'report',inputResultIds:[resultId],sha256:createHash('sha256').update(bytes).digest('hex'),bytesBase64:bytes.toString('base64')})
const ref=Object.fromEntries(['resultId','sha256','sourceId','sourceVersion','queryHash','rowCount','truncated'].map(key=>[key,manifest.artifact[key]]))
const committed=await client.execute('artifacts.commit',{commandId:randomUUID(),summary:bytes.toString(),artifactIds:[staged.artifactId],inputs:[ref],runtimeManifestSha256:'a'.repeat(64),limitations:['Deterministic external Node fixture; no upstream model inference.']})
process.stdout.write(JSON.stringify({outcome:'succeeded',summary:JSON.stringify({summary:committed.summary,commandId:committed.commandId,artifactId:staged.artifactId,resultId})}))
`)
 await writeFile(adapter,JSON.stringify({command:process.execPath,args:['--import',import.meta.resolve('tsx'),script]}))
 const ctx={cwd:directory,env:{PATH:process.env.PATH},log(){},warn(){}}
 const invoke=(op,...extra)=>agentCommand.run(parseArgs([op,'--state-file',state,...extra]),ctx)
 await invoke('connect');await invoke('run','--task',receipt.taskId,'--adapter-file',adapter)
 const completed=await channels.memberTask(member.memberToken,receipt.taskId)
 assert.equal(completed.state,'succeeded');const summary=JSON.parse(completed.summary)
 assert.equal(summary.summary,'Total 60 CNY');assert.equal(summary.resultId,frozen.resultId)
 const csrf=createCsrfService({db:f.db,deploymentId:f.deploymentId,origin,key:f.csrfKey})
 const ownerHeaders={origin,cookie:'__Host-dyoffice-session='+f.alice.token,'x-csrf-token':csrf.sessionToken(f.alice.token)}
 const delivery=await f.app.inject({url:'/api/v1/agents/deliveries/'+summary.commandId,headers:ownerHeaders})
 assert.equal(delivery.statusCode,200,delivery.body)
 assert.equal(delivery.json().inputs[0].sha256,frozen.sha256)
 const report=await f.app.inject({url:'/api/v1/agents/artifacts/'+summary.artifactId+'/content',headers:ownerHeaders})
 assert.equal(report.statusCode,200,report.body);assert.equal(report.body,'Total 60 CNY')
 assert.equal((await f.app.inject({url:'/api/v1/agents/artifacts/'+summary.artifactId+'/content',headers:{origin,cookie:'__Host-dyoffice-session='+f.bob.token}})).statusCode,404)
})
