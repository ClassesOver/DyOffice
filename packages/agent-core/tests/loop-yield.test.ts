import { describe, expect, it } from 'vitest'
import { AgentLoop, type AgentMessage, type AgentSkill, type AgentStreamCallbacks, type AgentTransport } from '../src'

function transport(script:(callbacks:AgentStreamCallbacks)=>void):AgentTransport & {requests:AgentMessage[][]} {
 const value:AgentTransport & {requests:AgentMessage[][]}={requests:[],stream(request,callbacks){value.requests.push(request.messages);queueMicrotask(()=>script(callbacks));return{cancel(){callbacks.onDone()}}}}
 return value
}

const flush=()=>new Promise(resolve=>setTimeout(resolve,0))
const call=(callbacks:AgentStreamCallbacks)=>{callbacks.onToolCall({id:'call-1',name:'delegate',input:{}});callbacks.onDone()}

describe('AgentLoop delegation yield',()=>{
 it('finishes paired tool results and releases the run after a successful delegated task',async()=>{
  let loop!:AgentLoop
  const t=transport(call)
  const skill:AgentSkill={id:'yield-test',systemPrompt:'test',tools:[{name:'delegate',description:'delegate',inputSchema:{type:'object'}}],executeTool:()=>{loop.requestYield(['task-1']);return{output:'accepted task-1',summary:'delegated'}}}
  let result:unknown
  loop=new AgentLoop({transport:t,skill,allowDelegationYield:true,events:{onDone:value=>{result=value}}})
  loop.run('delegate')
  await flush()
  expect(loop.busy).toBe(false)
  expect(result).toMatchObject({cancelled:false,yielded:{taskIds:['task-1']}})
  expect(loop.messages).toEqual([
   {role:'user',text:'delegate'},
   {role:'assistant',text:'',toolCalls:[{id:'call-1',name:'delegate',input:{}}]},
   {role:'tool',results:[{id:'call-1',name:'delegate',output:'accepted task-1',isError:undefined}]},
   {role:'assistant',text:'(completed tool actions; no text reply)'},
  ])
  expect(t.requests).toHaveLength(1)
 })

 it('rejects yield when the run did not explicitly enable delegation',()=>{
  const t=transport(()=>{})
  const loop=new AgentLoop({transport:t,skill:{id:'test',systemPrompt:'test',tools:[],executeTool:()=>({output:'',summary:''})}})
  expect(()=>loop.requestYield(['task-1'])).toThrow()
  expect(loop.busy).toBe(false)
 })

 it('does not yield when a delegated tool fails',async()=>{
  let loop!:AgentLoop
  const t=transport(call)
  const skill:AgentSkill={id:'yield-test',systemPrompt:'test',tools:[{name:'delegate',description:'delegate',inputSchema:{type:'object'}}],executeTool:()=>{loop.requestYield(['task-1']);return{output:'rejected',summary:'delegation failed',isError:true}}}
  let result:unknown
  loop=new AgentLoop({transport:t,skill,allowDelegationYield:true,maxTurns:1,events:{onDone:value=>{result=value}}})
  loop.run('delegate')
  await flush()
  expect(result).not.toHaveProperty('yielded')
 })

 it('cancellation wins over a pending yield',async()=>{
  let loop!:AgentLoop
  const t=transport(call)
  const skill:AgentSkill={id:'yield-test',systemPrompt:'test',tools:[{name:'delegate',description:'delegate',inputSchema:{type:'object'}}],executeTool:()=>{loop.requestYield(['task-1']);return new Promise(()=>{})}}
  let result:unknown
  loop=new AgentLoop({transport:t,skill,allowDelegationYield:true,events:{onDone:value=>{result=value}}})
  loop.run('delegate')
  await flush()
  loop.cancel()
  await flush()
  expect(result).toMatchObject({cancelled:true})
  expect(result).not.toHaveProperty('yielded')
 })
})
