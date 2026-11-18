import {describe, expect, it} from 'vitest'
import {createCodingSkill} from '../src/coding-skill'

describe('Office team delegation', () => {
  it('delegates only when invoked and returns errors as tool results', async () => {
    let calls = 0
    const skill = createCodingSkill({run: async input => {calls++; expect(input).toEqual({instruction:'write parser',context:'CSV columns'}); return {summary:'Parser tested',output:'parse.ts'}}})
    expect(calls).toBe(0)
    expect(skill.tools.map(t => t.name)).toEqual(['list_agents','delegate_agent_task'])
    const result = await skill.executeTool({id:'a',name:'delegate_agent_task',input:{instruction:'write parser',context:'CSV columns'}})
    expect(result.output).toContain('Parser tested')
    expect(result.mutated).not.toBe(true)
    expect(calls).toBe(1)
    const unavailable = createCodingSkill({run: async () => {throw Error('Codex unavailable')}})
    expect((await unavailable.executeTool({id:'b',name:'delegate_agent_task',input:{instruction:'code'}})).isError).toBe(true)
  })
  it('rejects unsupported calls and invalid input without starting Codex', async () => {
    let calls=0
    const skill=createCodingSkill({run:async()=>{calls++;return {summary:'ok',output:''}}})
    for(const call of [
      {id:'a',name:'other',input:{instruction:'code'}},
      {id:'b',name:'delegate_agent_task',input:{instruction:''}},
      {id:'c',name:'delegate_agent_task',input:{instruction:'code',cwd:'/etc'}},
    ]) expect((await skill.executeTool(call)).isError).toBe(true)
    expect(calls).toBe(0)
  })
  it('propagates cancellation to only the delegated task', async () => {
    const controller=new AbortController()
    const skill=createCodingSkill({run:async (_input,signal)=>{expect(signal).toBe(controller.signal);throw new DOMException('Stopped','AbortError')}})
    controller.abort()
    const result=await skill.executeTool({id:'a',name:'delegate_agent_task',input:{instruction:'code'}},controller.signal)
    expect(result.isError).toBe(true)
  })
})
