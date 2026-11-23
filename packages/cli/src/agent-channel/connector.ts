import {constants} from 'node:fs'
import {open, rename, unlink} from 'node:fs/promises'
import {isAbsolute} from 'node:path'
import {randomUUID} from 'node:crypto'
import {spawn} from 'node:child_process'
import {CHANNEL_LIMITS,type ChannelTask} from '../../../web-contracts/src/assistant-channel.ts'
import type {HarnessDataGrant} from '../../../web-contracts/src/harness-data.ts'
import type {ChannelClient} from './client'
import {CliError,EXIT} from '../result'

export interface ChannelState {
  origin: string
  applicationId?: string
  applicationToken?: string
  memberId?: string
  memberToken?: string
  conversationId?: string
  expiresAt?: string
  connectionId?: string
  connectionEpoch?: number
}
export async function readState(path: string): Promise<ChannelState> {
  const file=await open(path,constants.O_RDONLY | constants.O_NOFOLLOW)
  let state: ChannelState
  try {
    const info=await file.stat()
    if(!info.isFile() || info.nlink!==1 || (info.mode & 0o777)!==0o600)throw new CliError(EXIT.file,'Channel state must be a regular file with mode 0600')
    if(info.size>64*1024)throw new CliError(EXIT.file,'Channel state exceeds byte limit')
    try {state=JSON.parse(await file.readFile('utf8')) as ChannelState}
    catch {throw new CliError(EXIT.file,'Invalid channel state JSON')}
    if(!state || typeof state!=='object' || typeof state.origin!=='string')throw new CliError(EXIT.file,'Invalid channel state')
  } finally {await file.close()}
  return state
}
export async function writeState(path: string,state: ChannelState): Promise<void> {
  const temporary=`${path}.${randomUUID()}.tmp`
  const file=await open(temporary,'wx',0o600)
  try{await file.writeFile(JSON.stringify(state));await file.close();await rename(temporary,path)}catch(error){await file.close().catch(()=>{});await unlink(temporary).catch(()=>{});throw error}
}
export interface AdapterConfig {command: string;args: string[]}
export async function runAdapter(config: AdapterConfig,input: unknown,env: NodeJS.ProcessEnv,signal?:AbortSignal,timeoutMs=60_000): Promise<{summary:string;outcome:'succeeded'|'failed'}> {
  if(!isAbsolute(config.command) || !Array.isArray(config.args) || config.args.some(arg=>typeof arg!=='string'))
    throw new CliError(EXIT.usage,'Adapter requires an absolute executable and explicit string argv')
  if(signal?.aborted)throw new CliError(EXIT.app,'Harness adapter stopped')
  return new Promise((resolve,reject)=>{
    // A Linux process group lets cancellation stop the adapter's descendants too.
    const grouped=process.platform==='linux'
    const child=spawn(config.command,config.args,{shell:false,detached:grouped,env,stdio:['pipe','pipe','pipe']})
    let output='';let bytes=0;let settled=false;let stopping=false
    const kill=(kind:NodeJS.Signals)=>{try{if(grouped&&child.pid)process.kill(-child.pid,kind);else child.kill(kind)}catch{/* Process already exited. */}}
    const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',stop)}
    const fail=()=>{if(settled)return;settled=true;cleanup();kill('SIGKILL');reject(new CliError(EXIT.app,'Harness adapter failed or returned invalid bounded JSON'))}
    const stop=()=>{if(stopping||settled)return;stopping=true;kill('SIGTERM');setTimeout(()=>{kill('SIGKILL');fail()},250)}
    const timer=setTimeout(stop,timeoutMs)
    signal?.addEventListener('abort',stop,{once:true})
    child.on('error',fail);child.stdin.on('error',fail)
    child.stdout.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>256*1024)fail();else output+=chunk.toString('utf8')})
    child.stderr.resume()
    child.on('close',code=>{if(settled||stopping)return;clearTimeout(timer);if(code!==0)return fail();try{const result=JSON.parse(output);if(typeof result.summary!=='string' || Buffer.byteLength(result.summary)>32*1024 || !['succeeded','failed'].includes(result.outcome))return fail();settled=true;cleanup();resolve({summary:result.summary,outcome:result.outcome})}catch{fail()}})
    const payload=JSON.stringify(input)
    if(Buffer.byteLength(payload)>256*1024)return fail()
    child.stdin.end(payload+'\n')
    if(signal?.aborted)stop()
  })
}

export interface ClaimedChannelTask {claimId:string;instruction:string;deadlineAt?:string;dataInputs?:{sourceIds:string[];resultIds:string[]}}
/** Member credentials stay in the connector; only the task data grant enters stdin. */
export async function channelAdapterInput(client:ChannelClient,state:ChannelState,taskId:string,claim:ClaimedChannelTask,connectionEpoch:number) {
  const data=claim.dataInputs===undefined?undefined:await client.request<{baseUrl:string;grant:HarnessDataGrant}>('POST',
    `/members/${encodeURIComponent(state.memberId!)}/tasks/${encodeURIComponent(taskId)}/data-grant`,state.memberToken,{claimId:claim.claimId,connectionEpoch})
  if(data&&data.baseUrl!==client.origin+'/api/v1/agents')throw new CliError(EXIT.app,'Channel data origin changed')
  return {task:{taskId,instruction:claim.instruction},claim:{claimId:claim.claimId},connectionEpoch,...(data?{data}:{})}
}

type MemberTasks={paused:boolean;member:{connectionEpoch:number};tasks:Pick<ChannelTask,'taskId'|'to'|'state'|'claimId'|'connectionEpoch'>[]}
function memberTasks(client:ChannelClient,state:ChannelState,signal?:AbortSignal){
  return client.request<MemberTasks>('GET','/members/'+encodeURIComponent(state.memberId!)+'/tasks',state.memberToken,undefined,signal)
}

export async function runClaimedAdapter(options:{
  client:ChannelClient;state:ChannelState;taskId:string;claim:ClaimedChannelTask;connectionEpoch:number
  adapter:AdapterConfig;env:NodeJS.ProcessEnv;signal?:AbortSignal;renewClaim?:boolean
}) {
  const {client,state,taskId,claim,connectionEpoch,adapter,env,signal}=options
  if(signal?.aborted)throw new CliError(EXIT.app,'Harness adapter stopped')
  const input=await channelAdapterInput(client,state,taskId,claim,connectionEpoch)
  const sources=input.data?.grant?.inputs?.sourceIds
  if(!Array.isArray(sources)||!sources.length)return runAdapter(adapter,input,env,signal)
  const remaining=claim.deadlineAt===undefined?CHANNEL_LIMITS.deadlineMs:Date.parse(claim.deadlineAt)-Date.now()
  const timeoutMs=Math.min(CHANNEL_LIMITS.deadlineMs,remaining)
  if(!Number.isFinite(timeoutMs)||timeoutMs<1)throw new CliError(EXIT.app,'Channel task deadline expired')
  if(!options.renewClaim)return runAdapter(adapter,input,env,signal,timeoutMs)

  // Watch already polls. A one-shot source task must also renew its 45 s
  // member lease while the adapter waits for a multi-statement response.
  const controller=new AbortController(),stop=()=>controller.abort()
  const active=signal?AbortSignal.any([signal,controller.signal]):controller.signal
  let polling:Promise<void>|undefined,failure:unknown
  const timer=setInterval(()=>{
    if(polling||active.aborted)return
    polling=memberTasks(client,state,active).then(snapshot=>{
      if(snapshot.paused||snapshot.member.connectionEpoch!==connectionEpoch||!snapshot.tasks.some(task=>
        task.taskId===taskId&&task.to===state.memberId&&task.state==='running'&&task.claimId===claim.claimId&&task.connectionEpoch===connectionEpoch)){
        throw new CliError(EXIT.app,'Channel task claim is no longer active')
      }
    }).catch(error=>{if(!active.aborted){failure=error;stop()}}).finally(()=>{polling=undefined})
  },10_000)
  process.once('SIGINT',stop);process.once('SIGTERM',stop)
  try {
    return await runAdapter(adapter,input,env,active,timeoutMs)
  }catch(error){throw failure??error}
  finally {
    clearInterval(timer);process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop)
    stop();await polling
  }
}

/** Explicit Linux worker: never reclaims running/unknown tasks or retries a claim. */
export async function watchChannel(options:{client:ChannelClient;state:ChannelState;adapter:AdapterConfig;env:NodeJS.ProcessEnv;signal:AbortSignal;save:(state:ChannelState)=>Promise<void>}) {
  if(process.platform!=='linux')throw new CliError(EXIT.usage,'Agent watch requires Linux process-group cancellation')
  const {client,state,adapter,env,signal,save}=options
  if(!state.memberId||!state.memberToken||!state.conversationId)throw new CliError(EXIT.usage,'Redeem membership before watching')
  const member=`/members/${encodeURIComponent(state.memberId)}`,connectionId=randomUUID()
  const connected=await client.request<{connectionEpoch:number}>('POST',member+'/connect',state.memberToken,{connectionId})
  const connectionEpoch=connected.connectionEpoch
  let active:{taskId:string;controller:AbortController;work:Promise<void>}|undefined,failure:unknown
  const attempted=new Set<string>()
  const stop=()=>active?.controller.abort()
  signal.addEventListener('abort',stop,{once:true})
  const wait=()=>new Promise<void>(resolve=>{
    const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',done);resolve()}
    const timer=setTimeout(done,1000);signal.addEventListener('abort',done,{once:true});if(signal.aborted)done()
  })
  try {
    await save({...state,connectionId,connectionEpoch})
    while(!signal.aborted) {
      if(failure)throw failure
      const snapshot=await memberTasks(client,state)
      if(snapshot.member.connectionEpoch!==connectionEpoch)throw new CliError(EXIT.app,'Channel connection was superseded')
      if(snapshot.paused){active?.controller.abort();break}
      if(active&&!snapshot.tasks.some(task=>task.taskId===active!.taskId&&task.state==='running')){active.controller.abort();break}
      if(!active) {
        const task=snapshot.tasks.find(task=>task.state==='queued'&&task.to===state.memberId&&!attempted.has(task.taskId))
        if(task) {
          attempted.add(task.taskId)
          const claim=await client.request<ClaimedChannelTask>('POST',member+'/claim',state.memberToken,{taskId:task.taskId,connectionId,connectionEpoch})
          const controller=new AbortController()
          const running={taskId:task.taskId,controller,work:Promise.resolve()}
          active=running
          running.work=(async()=>{
            const result=await runClaimedAdapter({client,state,taskId:task.taskId,claim,connectionEpoch,adapter,env,signal:AbortSignal.any([signal,controller.signal])})
            if(controller.signal.aborted||signal.aborted)return
            await client.request('POST',member+'/actions',state.memberToken,{requestId:randomUUID(),conversationId:state.conversationId,to:'office',action:{kind:'result',taskId:task.taskId,claimId:claim.claimId,connectionEpoch,...result}})
          })().catch(error=>{failure=error}).finally(()=>{if(active===running)active=undefined})
        }
      }
      await wait()
    }
  } finally {
    signal.removeEventListener('abort',stop)
    active?.controller.abort();await active?.work
    try{await client.request('POST',member+'/disconnect',state.memberToken,{connectionId,connectionEpoch})}catch{/* Revoked or superseded connections already fence their claims. */}
    await save({...state,connectionId:undefined,connectionEpoch:undefined})
  }
}
