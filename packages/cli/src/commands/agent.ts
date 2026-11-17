import {readFile,lstat} from 'node:fs/promises'
import {resolve} from 'node:path'
import {randomUUID} from 'node:crypto'
import {flagString} from '../args'
import {assertAllowed} from '../fs'
import {ChannelClient} from '../agent-channel/client'
import {readState,writeState,runAdapter,watchChannel,channelAdapterInput,type ClaimedChannelTask,type AdapterConfig} from '../agent-channel/connector'
import type {CommandDef} from '../registry'
import {CliError,EXIT} from '../result'

export const agentCommand: CommandDef={
  name:'agent',
  summary:'Join an Office assistant channel or run an explicitly configured harness adapter (no MCP).',
  usage:'agent <join|status|redeem|connect|tasks|task|send|run|watch> --state-file <file> [options]',
  options:[
    {name:'state-file',value:'file',description:'Private 0600 credential state; or GENOFFICE_AGENT_STATE_FILE'},
    {name:'origin',value:'origin',description:'Office HTTPS origin for join; or GENOFFICE_AGENT_ORIGIN'},
    {name:'invite-file',value:'file',description:'Invitation token file for join; or GENOFFICE_AGENT_INVITE_TOKEN environment'},
    {name:'name',value:'name',description:'Display name for join'},
    {name:'kind',value:'kind',description:'Harness display kind (default custom)'},
    {name:'task',value:'id',description:'Explicit task ID for task or run'},
    {name:'action-file',value:'file',description:'JSON {to,action,requestId?} for send; contents are never logged'},
    {name:'adapter-file',value:'file',description:'JSON {command:absoluteExecutable,args:string[]} for one task run; JSON stdin/stdout protocol'},
  ],
  async run(args,ctx){
    const operation=args.positionals[0]
    if(args.positionals.length!==1 || !['join','status','redeem','connect','tasks','task','send','run','watch'].includes(operation))
      throw new CliError(EXIT.usage,'Choose agent join, status, redeem, connect, tasks, task, send, run, or watch')
    const required=(name:string)=>{const value=flagString(args,name);if(!value)throw new CliError(EXIT.usage,`Missing --${name}`);return value}
    const stateName=flagString(args,'state-file') ?? ctx.env.GENOFFICE_AGENT_STATE_FILE
    if(!stateName)throw new CliError(EXIT.usage,'Missing --state-file or GENOFFICE_AGENT_STATE_FILE')
    const path=resolve(ctx.cwd,stateName);assertAllowed(path,ctx.env,'read');assertAllowed(path,ctx.env,'write')
    const readJson=async(name:string)=>{const file=resolve(ctx.cwd,required(name));assertAllowed(file,ctx.env,'read');if((await lstat(file)).size>256*1024)throw new CliError(EXIT.file,'Input file exceeds byte limit');try{return JSON.parse(await readFile(file,'utf8'))}catch{throw new CliError(EXIT.file,'Invalid input JSON')}}
    if(operation==='join'){
      try{await lstat(path);throw new CliError(EXIT.file,'Channel state already exists; choose a new state file')}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
      const origin=flagString(args,'origin') ?? ctx.env.GENOFFICE_AGENT_ORIGIN
      if(!origin)throw new CliError(EXIT.usage,'Missing channel origin')
      const client=new ChannelClient(origin)
      const inviteFile=flagString(args,'invite-file');let inviteToken=ctx.env.GENOFFICE_AGENT_INVITE_TOKEN
      if(inviteFile){const file=resolve(ctx.cwd,inviteFile);assertAllowed(file,ctx.env,'read');if((await lstat(file)).size>4096)throw new CliError(EXIT.file,'Invitation file exceeds byte limit');inviteToken=(await readFile(file,'utf8')).trim()}
      if(!inviteToken)throw new CliError(EXIT.usage,'Provide --invite-file or GENOFFICE_AGENT_INVITE_TOKEN')
      const response=await client.request<{applicationId:string;applicationToken:string}>('POST','/applications',undefined,{inviteToken,name:required('name'),kind:flagString(args,'kind') ?? 'custom'})
      await writeState(path,{origin:client.origin,...response})
      return {summary:'Application submitted; approval is required in Office.',detail:{applicationId:response.applicationId}}
    }
    const state=await readState(path);const client=new ChannelClient(state.origin)
    const application=()=>{if(!state.applicationId || !state.applicationToken)throw new CliError(EXIT.usage,'Application credentials are unavailable');return `/applications/${encodeURIComponent(state.applicationId)}`}
    if(operation==='status'){
      const response=await client.request('GET',application(),state.applicationToken)
      return {summary:'Application status retrieved.',detail:{state:response.state,applicationId:state.applicationId}}
    }
    if(operation==='redeem'){
      const response=await client.request<{memberId:string;memberToken:string;conversationId:string;expiresAt:string}>('POST',`${application()}/redeem`,state.applicationToken,{})
      await writeState(path,{origin:state.origin,...response})
      return {summary:'Member credentials saved.',detail:{memberId:response.memberId,conversationId:response.conversationId,expiresAt:response.expiresAt}}
    }
    if(!state.memberId || !state.memberToken || !state.conversationId)throw new CliError(EXIT.usage,'Redeem approved membership first')
    const member=`/members/${encodeURIComponent(state.memberId)}`
    if(operation==='connect'){
      const connectionId=randomUUID()
      const response=await client.request<{connectionEpoch:number}>('POST',`${member}/connect`,state.memberToken,{connectionId})
      await writeState(path,{...state,connectionId,connectionEpoch:response.connectionEpoch})
      return {summary:'Connected with a new execution epoch.',detail:{connectionEpoch:response.connectionEpoch}}
    }
    if(operation==='tasks' || operation==='task'){
      const response=await client.request('GET',`${member}/tasks${operation==='task'?`/${encodeURIComponent(required('task'))}`:''}`,state.memberToken)
      return {summary:'Authorized tasks retrieved.',detail:response}
    }
    if(operation==='send'){
      const input=await readJson('action-file')
      const receipt=await client.request('POST',`${member}/actions`,state.memberToken,{requestId:input.requestId ?? randomUUID(),conversationId:state.conversationId,to:input.to,action:input.action})
      return {summary:'Channel action submitted.',detail:receipt}
    }
    if(operation==='watch') {
      const adapter=await readJson('adapter-file') as AdapterConfig
      if(!adapter || typeof adapter.command!=='string' || !adapter.command.startsWith('/') || !Array.isArray(adapter.args) || adapter.args.some(arg=>typeof arg!=='string'))throw new CliError(EXIT.usage,'Invalid adapter configuration')
      const controller=new AbortController(),stop=()=>controller.abort()
      process.once('SIGINT',stop);process.once('SIGTERM',stop)
      let ownedConnection:string|undefined
      try {
        await watchChannel({client,state,adapter,env:{PATH:ctx.env.PATH},signal:controller.signal,save:async next=>{
          if(next.connectionId){ownedConnection=next.connectionId;await writeState(path,next)}
          else if((await readState(path)).connectionId===ownedConnection)await writeState(path,next)
        }})
      } finally {process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop)}
      return {summary:'Channel watcher stopped; interrupted execution requires outcome review.'}
    }
    if(!state.connectionId || !Number.isSafeInteger(state.connectionEpoch))throw new CliError(EXIT.usage,'Connect before running a task')
    const taskId=required('task');const config=await readJson('adapter-file') as AdapterConfig
    // Validate adapter configuration before acquiring an execution claim.
    if(typeof config.command!=='string' || !config.command.startsWith('/') || !Array.isArray(config.args) || config.args.some(arg=>typeof arg!=='string'))throw new CliError(EXIT.usage,'Invalid adapter configuration')
    const claim=await client.request<ClaimedChannelTask>('POST',`${member}/claim`,state.memberToken,{taskId,connectionId:state.connectionId,connectionEpoch:state.connectionEpoch})
    const input=await channelAdapterInput(client,state,taskId,claim,state.connectionEpoch!)
    const result=await runAdapter(config,input,{PATH:ctx.env.PATH})
    const receipt=await client.request('POST',`${member}/actions`,state.memberToken,{requestId:randomUUID(),conversationId:state.conversationId,to:'office',action:{kind:'result',taskId,claimId:claim.claimId,connectionEpoch:state.connectionEpoch,...result}})
    return {summary:'Harness task result submitted.',detail:receipt}
  },
}
