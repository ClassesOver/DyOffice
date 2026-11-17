import type {FastifyInstance,FastifyRequest} from 'fastify'
import {cookies,uniqueHeader,type createCsrfService} from '../auth/csrf.ts'
import {channelObject as object,channelUuid as uuid,decodeAgentAction} from '../../../../../../packages/web-contracts/src/assistant-channel.ts'
import type {createHarnessDataAccess} from '../coding/data-access.ts'
import type {createAssistantChannelService} from './service.ts'

export function registerAssistantChannelRoutes(app:FastifyInstance,service:ReturnType<typeof createAssistantChannelService>,csrf:ReturnType<typeof createCsrfService>,dataOptions?:{data:ReturnType<typeof createHarnessDataAccess>;baseUrl:string}) {
 const base='/api/v1/assistant-channels'
 const owner=(request:FastifyRequest)=>{
  const token=cookies(request).session??''
  if(request.method==='GET')csrf.requireSessionRead(request,token);else csrf.requireSession(request,token)
  return token
 }
 const bearer=(request:FastifyRequest)=>{
  const header=uniqueHeader(request,'authorization')
  if(uniqueHeader(request,'cookie')!==undefined||typeof header!=='string'||!/^Bearer [A-Za-z0-9_.-]{1,2048}$/.test(header))throw Object.assign(Error('Channel authorization unavailable'),{statusCode:401})
  return header.slice(7)
 }
 const body=(request:FastifyRequest,keys:readonly string[])=>object(request.body,keys)
 const member=async(request:FastifyRequest,id:string)=>{
  const token=bearer(request),snapshot=await service.memberSnapshot(token)
  if(snapshot.member.membershipId!==uuid(id))throw Object.assign(Error('Channel unavailable'),{statusCode:403})
  return {token,snapshot,credential:{kind:'member' as const,token}}
 }
 app.register(async api=>{
  api.addHook('onRequest',async(_request,reply)=>{reply.header('Cache-Control','private, no-store')})
  api.post(base+'/channels',{bodyLimit:4096},request=>{
   const value=body(request,['fileId','conversationId']);return service.createConversation(owner(request),{fileId:uuid(value.fileId),...(value.conversationId===undefined?{}:{conversationId:uuid(value.conversationId)})})
  })
  api.get<{Params:{id:string}}>(base+'/channels/:id',request=>service.snapshot(owner(request),uuid(request.params.id)))
  api.post<{Params:{id:string}}>(base+'/channels/:id/invitations',request=>{body(request,[]);return service.invite(owner(request),uuid(request.params.id))})
  api.post<{Params:{id:string;applicationId:string}}>(base+'/channels/:id/applications/:applicationId/approve',request=>{
   const value=body(request,['approved']);return service.approve(owner(request),uuid(request.params.id),uuid(request.params.applicationId),{approved:value.approved as boolean})
  })
  api.post<{Params:{id:string;memberId:string}}>(base+'/channels/:id/members/:memberId/revoke',request=>{body(request,[]);return service.revoke(owner(request),uuid(request.params.id),uuid(request.params.memberId))})
  api.post<{Params:{id:string}}>(base+'/channels/:id/pause',request=>{
   const value=body(request,['paused']);return service.setPaused(owner(request),uuid(request.params.id),value.paused as boolean)
  })
  api.post<{Params:{id:string}}>(base+'/channels/:id/connect',request=>{
   const value=body(request,['connectionId','editorId','editorGeneration'])
   return service.connect({kind:'owner',token:owner(request)},uuid(request.params.id),{connectionId:uuid(value.connectionId),editorId:uuid(value.editorId),editorGeneration:value.editorGeneration as number})
  })
  api.post<{Params:{id:string}}>(base+'/channels/:id/office-task',{bodyLimit:65536},request=>{
   const value=body(request,['requestId','connectionId','connectionEpoch','instruction'])
   return service.beginOfficeTask(owner(request),uuid(request.params.id),{requestId:uuid(value.requestId),connectionId:uuid(value.connectionId),connectionEpoch:value.connectionEpoch as number,instruction:value.instruction as string})
  })
  api.post<{Params:{id:string}}>(base+'/channels/:id/claim',request=>{
   const value=body(request,['taskId','connectionId','connectionEpoch','requestId'])
   return service.claim({kind:'owner',token:owner(request)},uuid(request.params.id),{taskId:uuid(value.taskId),connectionId:uuid(value.connectionId),connectionEpoch:value.connectionEpoch as number,...(value.requestId===undefined?{}:{requestId:uuid(value.requestId)})})
  })
  for(const operation of ['disconnect','yield','reconcile'] as const)api.post<{Params:{id:string}}>(base+'/channels/:id/'+operation,request=>{
   const keys=operation==='disconnect'?['connectionId','connectionEpoch']:operation==='yield'?['taskId','claimId','connectionEpoch','childTaskIds']:['taskId','claimId','connectionEpoch','outcome','summary']
   const value=body(request,keys),credential={kind:'owner' as const,token:owner(request)},id=uuid(request.params.id)
   if(operation==='disconnect')return service.disconnect(credential,id,{connectionId:uuid(value.connectionId),connectionEpoch:value.connectionEpoch as number})
   if(operation==='yield')return service.yieldTask(credential,id,{taskId:uuid(value.taskId),claimId:uuid(value.claimId),connectionEpoch:value.connectionEpoch as number,childTaskIds:value.childTaskIds as string[]})
   return service.reconcile(credential,id,{taskId:uuid(value.taskId),claimId:uuid(value.claimId),connectionEpoch:value.connectionEpoch as number,outcome:value.outcome as 'succeeded'|'failed'|'cancelled',summary:value.summary as string})
  })
  api.post(base+'/actions',{bodyLimit:65536},request=>service.submit({kind:'owner',token:owner(request)},decodeAgentAction(request.body)))
  api.post(base+'/applications',{bodyLimit:8192},request=>{
   const value=body(request,['inviteToken','name','kind'])
   return service.apply(value.inviteToken as string,{displayName:value.name as string,kind:value.kind as string})
  })
  api.get<{Params:{id:string}}>(base+'/applications/:id',async request=>{
   const result=await service.applicationStatus(bearer(request));if(result.applicationId!==uuid(request.params.id))throw Object.assign(Error('Application unavailable'),{statusCode:403});return result
  })
  api.post<{Params:{id:string}}>(base+'/applications/:id/redeem',async request=>{
   body(request,[]);const token=bearer(request),status=await service.applicationStatus(token)
   if(status.applicationId!==uuid(request.params.id))throw Object.assign(Error('Application unavailable'),{statusCode:403})
   const result=await service.redeem(token)
   return {...result,memberId:result.member.membershipId,expiresAt:result.member.expiresAt}
  })
  api.get<{Params:{id:string}}>(base+'/members/:id/tasks',async request=>(await member(request,request.params.id)).snapshot)
  api.get<{Params:{id:string;taskId:string}}>(base+'/members/:id/tasks/:taskId',async request=>{
   const {token}=await member(request,request.params.id)
   return service.memberTask(token,uuid(request.params.taskId))
  })
  if(dataOptions)api.post<{Params:{id:string;taskId:string}}>(base+'/members/:id/tasks/:taskId/data-grant',{bodyLimit:4096},async request=>{
   const value=body(request,['claimId','connectionEpoch']),{token}=await member(request,request.params.id)
   const input={taskId:uuid(request.params.taskId),claimId:uuid(value.claimId),connectionEpoch:value.connectionEpoch as number}
   const binding=await service.authorizeDataClaim(token,input)
   const ttlMs=Math.min(600000,Date.parse(binding.deadlineAt)-Date.now())
   if(ttlMs<1)throw Object.assign(Error('Channel data unavailable'),{statusCode:403})
   const grant=await dataOptions.data.issue({token:binding.ownerToken,agentId:binding.agentId,inputs:binding.inputs,
    signal:AbortSignal.timeout(ttlMs),ttlMs,authorize:async()=>{await service.authorizeDataClaim(token,input)}})
   return {baseUrl:dataOptions.baseUrl,grant}
  })
  api.post<{Params:{id:string}}>(base+'/members/:id/connect',async request=>{
   const value=body(request,['connectionId']),{snapshot,credential}=await member(request,request.params.id)
   return service.connect(credential,snapshot.conversationId,{connectionId:uuid(value.connectionId)})
  })
  api.post<{Params:{id:string}}>(base+'/members/:id/claim',async request=>{
   const value=body(request,['taskId','connectionId','connectionEpoch','requestId']),{snapshot,credential}=await member(request,request.params.id)
   return service.claim(credential,snapshot.conversationId,{taskId:uuid(value.taskId),connectionId:uuid(value.connectionId),connectionEpoch:value.connectionEpoch as number,...(value.requestId===undefined?{}:{requestId:uuid(value.requestId)})})
  })
  for(const operation of ['disconnect','yield','reconcile'] as const)api.post<{Params:{id:string}}>(base+'/members/:id/'+operation,async request=>{
   const keys=operation==='disconnect'?['connectionId','connectionEpoch']:operation==='yield'?['taskId','claimId','connectionEpoch','childTaskIds']:['taskId','claimId','connectionEpoch','outcome','summary']
   const value=body(request,keys),{snapshot,credential}=await member(request,request.params.id),id=snapshot.conversationId
   if(operation==='disconnect')return service.disconnect(credential,id,{connectionId:uuid(value.connectionId),connectionEpoch:value.connectionEpoch as number})
   if(operation==='yield')return service.yieldTask(credential,id,{taskId:uuid(value.taskId),claimId:uuid(value.claimId),connectionEpoch:value.connectionEpoch as number,childTaskIds:value.childTaskIds as string[]})
   return service.reconcile(credential,id,{taskId:uuid(value.taskId),claimId:uuid(value.claimId),connectionEpoch:value.connectionEpoch as number,outcome:value.outcome as 'succeeded'|'failed'|'cancelled',summary:value.summary as string})
  })
  api.post<{Params:{id:string}}>(base+'/members/:id/actions',{bodyLimit:65536},async request=>{
   const {snapshot,credential}=await member(request,request.params.id),value=decodeAgentAction(request.body)
   if(value.conversationId!==snapshot.conversationId)throw Object.assign(Error('Channel unavailable'),{statusCode:403})
   return service.submit(credential,value)
  })
 })
}
