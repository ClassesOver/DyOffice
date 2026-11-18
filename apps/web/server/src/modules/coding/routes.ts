import type {FastifyInstance} from 'fastify'
import type {SessionService} from '../auth/sessions.ts'
import {cookies,type createCsrfService} from '../auth/csrf.ts'
import {registerProviderRoutes} from '../providers/routes.ts'
import {createProviderTurns} from '../providers/turns.ts'
import type {HarnessRunContext,HarnessRegistry} from './registry.ts'
import type {createHarnessDataAccess} from './data-access.ts'
import type {CodingTask,CodingProgress,CodingResult} from '../../../../../../packages/agent-core/src/coding-skill.ts'

export function registerCodingRoutes(app:FastifyInstance,options:{
  data?:ReturnType<typeof createHarnessDataAccess>;dataBaseUrl?:string
  openModel?:(token:string,modelId:string,signal:AbortSignal,onProgress?:(event:CodingProgress)=>void)=>ReturnType<NonNullable<HarnessRunContext['openModel']>>
  registry:HarnessRegistry;sessions:Pick<SessionService,'authenticate'>;
  csrf:Pick<ReturnType<typeof createCsrfService>,'requireSession'|'requireSessionRead'>
}) {
  const identity=async(token:string)=>{
    const principal=await options.sessions.authenticate(token)
    if(!principal.roles.includes('personal'))throw Object.assign(Error('Coding unavailable'),{statusCode:403})
    return {deploymentId:principal.deploymentId,userId:principal.userId,sessionId:principal.sessionId}
  }
  const turns=createProviderTurns({
    identity,
    async authorize(token,modelId) {
      if(!options.registry.list().some(a=>a.id===modelId))throw Error('Coding agent unavailable')
      return {identity:await identity(token),revision:modelId}
    },
    async revalidate(token,permit) {
      if(JSON.stringify(await identity(token))!==JSON.stringify(permit.identity))throw Error('Coding session changed')
    },
    async *stream(permit,request,signal,{token}) {
      if(request.system!==''||request.tools.length||request.messages.length!==1)throw Error('Invalid coding request')
      const message=request.messages[0] as Record<string,unknown>
      if(!message||Object.keys(message).some(k=>!['role','text'].includes(k))||message.role!=='user'||typeof message.text!=='string')throw Error('Invalid coding request')
      const input=JSON.parse(message.text) as CodingTask & {officeModelId?:string}
      if(!input||Array.isArray(input)||Object.keys(input).some(k=>!['instruction','context','officeModelId','dataInputs'].includes(k))||
        typeof input.instruction!=='string'||!input.instruction.trim()||input.instruction.length>16000||
        (input.context!==undefined&&(typeof input.context!=='string'||input.context.length>32000)))throw Error('Invalid coding request')
      if(typeof input.officeModelId!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(input.officeModelId))throw Error('Office model required')
      const {officeModelId,...task}=input
      if(task.dataInputs!==undefined&&!options.data)throw Error('Harness data unavailable')
      const grant=options.data&&task.dataInputs!==undefined?await options.data.issue({token,agentId:permit.revision,inputs:task.dataInputs??{sourceIds:[],resultIds:[]},signal}):undefined
      try {
        // Only bounded public progress crosses SSE; command stdout and reasoning stay local.
        const queue:CodingProgress[]=[]
        let wake:(()=>void)|undefined,finished=false,progressBytes=0
        const onProgress=(event:CodingProgress)=>{
          if(signal.aborted||finished)return
          const progress={kind:event.kind,text:event.text.slice(0,4000)}
          const bytes=Buffer.byteLength(JSON.stringify({type:'progress',...progress}))
          if(queue.length>=64||progressBytes+bytes>64*1024)return
          progressBytes+=bytes
          queue.push(progress);wake?.();wake=undefined
        }
        onProgress({kind:'status',text:'Starting harness'})
        const pending=options.registry.run(permit.identity.deploymentId+':'+permit.identity.userId,{...task,agentId:permit.revision},signal,{
          modelId:officeModelId,onProgress,...(options.openModel?{openModel:()=>options.openModel!(token,officeModelId,signal,onProgress)}:{}),
          ...(grant?{data:{baseUrl:options.dataBaseUrl!,grant}}:{})})
        let result:CodingResult|undefined,failure:unknown
        void pending.then(value=>{result=value},error=>{failure=error}).finally(()=>{finished=true;wake?.();wake=undefined})
        const abort=()=>{wake?.();wake=undefined}
        signal.addEventListener('abort',abort,{once:true})
        try {
          while(!finished||queue.length){
            if(signal.aborted)throw Error('Coding task cancelled')
            const progress=queue.shift()
            if(progress)yield {type:'progress' as const,...progress}
            else await new Promise<void>(resolve=>{wake=resolve})
          }
        } finally {signal.removeEventListener('abort',abort)}
        if(failure)throw failure
        if(!result)throw Error('Coding result unavailable')
        const delivery=grant?await options.data!.delivery(grant.taskId,grant.credential):undefined
        const {delivery:ignored,...output}=result
        yield {type:'delta' as const,text:JSON.stringify({...output,...(delivery?{delivery}:{})})}
      } finally {if(grant)options.data!.revoke(grant.taskId)}
    },
  },{timeoutMs:610000,maxActive:4,maxOutputBytes:384*1024})
  registerProviderRoutes(app,{...options,turns,endpoint:'/api/v1/agents/tasks',errorMessage:'Coding agent unavailable'})
  app.get('/api/v1/agents/catalog',async(request,reply)=>{
    reply.header('Cache-Control','private, no-store')
    const token=cookies(request).session??''
    if(!token)throw Object.assign(Error('Unauthorized'),{statusCode:401})
    options.csrf.requireSessionRead(request,token)
    await identity(token)
    return {agents:options.registry.list(),defaultId:options.registry.defaultId}
  })
  app.addHook('preClose',async()=>turns.dispose())
  return turns
}
