import {maintainTaskLease} from '../tasks/lease.ts'
import type {ObjectStore} from '../../storage/object-store.ts'
import type {createAssistantChannelService} from './service.ts'
import type {AssistantBackgroundStore} from './background-store.ts'
import type {BackgroundFormat} from './background-format.ts'
import {readBackgroundDocument} from './background-read.ts'

export interface BackgroundAnswerInput {token:string;instruction:string;text:string;revision:string;format:BackgroundFormat;truncated:boolean;tools:readonly [];signal:AbortSignal}
export function createAssistantBackgroundRunner(options:{
 store:AssistantBackgroundStore;service:ReturnType<typeof createAssistantChannelService>;objects:ObjectStore
 answer:(input:BackgroundAnswerInput)=>Promise<string>
}) {
 let stopped=false,busy=false,idleDelay=1000,timer:ReturnType<typeof setTimeout>|undefined,active:AbortController|undefined,pending:Promise<unknown>|undefined,activeRun:Promise<boolean>|undefined
 async function executeOnce():Promise<boolean>{
  if(stopped||busy)return false
  busy=true
  try {
   const claim=await options.store.take()
   if(!claim)return false
   if(claim.expired||stopped){await options.store.abandon(claim);return true}
   const controller=new AbortController();active=controller
   let stopLease:(()=>Promise<void>)|undefined
   let deadline:ReturnType<typeof setTimeout>|undefined
   try{
    const task=await options.service.backgroundStep(claim,'begin')
    if(!task)return false
    stopLease=maintainTaskLease(controller,5000,async()=>{
     try{return !!await options.service.backgroundStep(claim,'check')}
     catch(error){
      const status=(error as {statusCode?:number})?.statusCode
      if(status!==undefined&&status>=400&&status<500)return false
      throw error
     }
    })
    deadline=setTimeout(()=>controller.abort(),Math.max(1,Date.parse(task.deadlineAt)-Date.now()))
    const bytes=await options.objects.readVerified(task.reference,controller.signal)
    const document=await readBackgroundDocument(bytes,task.format,controller.signal)
    await options.service.backgroundStep(claim,'check')
    const summary=await options.answer({...document,...task,tools:[],signal:controller.signal})
    if(controller.signal.aborted)throw Error('Background task stopped')
    await options.service.backgroundStep(claim,'finish',{summary,outcome:'succeeded'})
   }catch{
    try{
     await options.service.backgroundStep(claim,'finish',{summary:'后台读取未完成，请检查文档、模型配置或任务授权。',outcome:'failed'})
    }catch{await options.store.abandon(claim)}
   }finally{clearTimeout(deadline);await stopLease?.();active=undefined}
   return true
  }finally{busy=false}
 }
 function runOnce():Promise<boolean>{
  if(stopped||busy)return Promise.resolve(false)
  return activeRun=executeOnce()
 }
 const tick=()=>{
  pending=runOnce().catch(()=>false).then(work=>{if(!stopped)timer=setTimeout(tick,work?0:idleDelay);idleDelay=work?1000:Math.min(5000,idleDelay+1000)})
 }
 return {runOnce,start(){if(!stopped&&!timer&&!pending)tick()},dispose(){stopped=true;clearTimeout(timer);active?.abort()},async drain(){await Promise.all([pending,activeRun])}}
}
