import type {FastifyInstance} from 'fastify'
import type {SessionService} from '../auth/sessions.ts'
import {cookies,type createCsrfService} from '../auth/csrf.ts'
import {registerProviderRoutes} from '../providers/routes.ts'
import {createProviderTurns} from '../providers/turns.ts'
import type {HarnessRunContext,HarnessRegistry} from './registry.ts'
import type {createHarnessDataAccess} from './data-access.ts'
import type {CodingTask} from '../../../../../../packages/agent-core/src/coding-skill.ts'

export function registerCodingRoutes(app:FastifyInstance,options:{
  data?:ReturnType<typeof createHarnessDataAccess>;dataBaseUrl?:string
  openModel?:(token:string,modelId:string,signal:AbortSignal)=>ReturnType<NonNullable<HarnessRunContext['openModel']>>
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
        const result=await options.registry.run(permit.identity.deploymentId+':'+permit.identity.userId,{...task,agentId:permit.revision},signal,{
          modelId:officeModelId,...(options.openModel?{openModel:()=>options.openModel!(token,officeModelId,signal)}:{}),
          ...(grant?{data:{baseUrl:options.dataBaseUrl!,grant}}:{})})
        const delivery=grant?await options.data!.delivery(grant.taskId,grant.credential):undefined
        const {delivery:ignored,...output}=result
        yield {type:'delta' as const,text:JSON.stringify({...output,...(delivery?{delivery}:{})})}
      } finally {if(grant)options.data!.revoke(grant.taskId)}
    },
  },{timeoutMs:610000,maxActive:4,maxOutputBytes:256*1024})
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
