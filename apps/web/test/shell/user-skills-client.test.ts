import {test, expect} from 'vitest'
import {createUserSkillsClient} from '../../src/shell/user-skills-client'
import {createLocalShellClient} from '../../src/shell/local-client'

test('imports SKILL.md using existing metadata parser and never sends owner or filesystem paths', async () => {
  const requests: unknown[] = []
  const client = createUserSkillsClient(async (path, method, body) => {
    requests.push({path, method, body})
    return {name: 'report', description: 'Private report'} as never
  })
  const result = await client.importText('---\nname: report\ndescription: Private report\n---\n# Write a DOCX report')
  expect(requests).toEqual([{path: '/api/v1/skills/report', method: 'PUT', body: {description: 'Private report', body: '# Write a DOCX report'}}])
  expect(result.name).toBe('report')
  await expect(client.importText('---\nname: ../alice\ndescription: bad\n---\nbody')).rejects.toThrow()
  expect(requests).toHaveLength(1)
})

test('a Skills response completing after account invalidation is rejected before entering the menu', async () => {
  let resolve!: (r: Response) => void
  const local = createLocalShellClient(() => new Promise(r => {resolve = r}))
  const work = createUserSkillsClient(local.request).listSkills()
  local.invalidateSession()
  resolve(new Response(JSON.stringify([{name: 'alice-private', description: 'secret'}])))
  await expect(work).rejects.toMatchObject({code: 'stale_session'})
})

test('a reply from a previous account is discarded when a different tab changes its session', async () => {
  let proof = 'a'.repeat(43)
  const local = createLocalShellClient(async (path, init) => {
    if (String(path).endsWith('/session-proof')) return new Response(JSON.stringify({csrfToken: proof}))
    expect((init?.headers as Record<string,string>)['X-CSRF-Token']).toBe('a'.repeat(43))
    proof = 'b'.repeat(43)
    return new Response(JSON.stringify([{name: 'alice-private', description: 'secret'}]))
  })
  const bound = await local.bindSession()
  await expect(createUserSkillsClient(bound.request).listSkills()).rejects.toMatchObject({code: 'stale_session'})
})

test('only four Office families reach the shared menu, including body-only classifications', async () => {
  const items = [{name:'html-clean',description:'HTML Markdown finance'}, {name:'word-template',description:'Word template'}, {name:'generic',description:'Team workflow'}, {name:'doctor',description:'command documentation'}]
  const client = createUserSkillsClient(async path => {
    if (path === '/api/v1/skills') return items as never
    const item = items.find(item => path.endsWith('/'+item.name))!
    return {...item,body:item.name === 'generic' ? 'Edit .xlsx workbooks' : 'Unrelated instructions'} as never
  })
  expect((await client.listSkills()).map(item=>item.name)).toEqual(['word-template','generic'])
  await expect(client.skillText('html-clean')).rejects.toThrow('Word')
  expect(await client.skillText('generic')).toBe('Edit .xlsx workbooks')
})

test('unrelated imports never write and similarly spelled names do not match', async () => {
  const calls: string[]=[]
  const client=createUserSkillsClient(async path=>{calls.push(path);return {} as never})
  for (const name of ['html','markdown','finance','doctor','cmd']) {
    await expect(client.importText(`---\nname: ${name}\ndescription: generic helper\n---\nUse HTML and Markdown for finance.`)).rejects.toThrow('Word')
  }
  expect(calls).toEqual([])
})

test('all four supported formats can be imported and remain classified from their body',async()=>{
 const client=createUserSkillsClient(async path=>({name:path.split('/').pop(),description:'Team workflow'}) as never)
 for (const format of ['docx','xlsx','pptx','pdf']) {
   const imported=await client.importText(`---\nname: team-${format}\ndescription: Team workflow\n---\nEdit a .${format} file`)
   expect(imported.relevance).toEqual({relevant:true,matched:[format]})
 }
})

test('HTML and Markdown task skills are excluded even when they mention Office formats',async()=>{
 const writes:unknown[]=[]
 const client=createUserSkillsClient(async(path,method,body)=>{if(method==='PUT')writes.push(body);if(path==='/api/v1/skills')return [{name:'word-html',description:'Convert Word to HTML'},{name:'markdown-pdf',description:'Markdown to PDF'}] as never;return {body:'Use DOCX and PDF'} as never})
 expect(await client.listSkills()).toEqual([])
 for(const name of ['word-html','markdown-pdf'])await expect(client.importText(`---\nname: ${name}\ndescription: Office conversion\n---\nUse Word and PDF tools.`)).rejects.toThrow('Word')
 expect(writes).toEqual([])
})


test('personal lists do not inject defaults or reserve earlier experimental names',async()=>{
 const calls:{path:string;method?:string}[]=[]
 const client=createUserSkillsClient(async(path,method)=>{calls.push({path,method});if(method==='PUT')return {name:'web-weekly-report',description:'Word report'} as never;return [] as never})
 expect(await client.listSkills()).toEqual([])
 await client.importText('---\nname: web-weekly-report\ndescription: Word report\n---\nUse document tools')
 await client.removeSkill('web-weekly-report')
 expect(calls.map(call=>call.method)).toEqual([undefined,'PUT','DELETE'])
})

test('catalog installation checks all account names and never overwrites a hidden unrelated record',async()=>{
 const calls:{path:string;method?:string}[]=[]
 const client=createUserSkillsClient(async(path,method)=>{calls.push({path,method});return [{name:'weekly-report',description:'Unrelated old record'}] as never})
 await expect(client.importText('---\nname: weekly-report\ndescription: Word report\n---\nUse document tools',{overwrite:false})).rejects.toMatchObject({status:409})
 expect(calls).toEqual([{path:'/api/v1/skills',method:undefined}])
})
test('duplicate preflight failures are explicitly pre-write while PUT failures retain unknown-write semantics',async()=>{
 const source='---\nname: report\ndescription: Word report\n---\nUse document tools'
 const preflight=createUserSkillsClient(async()=>{throw Error('offline')})
 await expect(preflight.importText(source,{overwrite:false})).rejects.toMatchObject({mutationStarted:false})
 const write=createUserSkillsClient(async(_path,method)=>{if(method==='PUT')throw Error('lost response');return [] as never})
 const error=await write.importText(source,{overwrite:false}).catch(error=>error)
 expect(error.message).toBe('lost response');expect(error.mutationStarted).not.toBe(false)
})
test('create-only imports carry the atomic server condition and explicit replacement retains update semantics',async()=>{
 const writes:unknown[]=[]
 const client=createUserSkillsClient(async(_path,method,body)=>{if(method==='PUT'){writes.push(body);return {name:'report',description:'Word report'} as never}return [] as never})
 const source='---\nname: report\ndescription: Word report\n---\nWord instructions'
 await client.importText(source,{overwrite:false});await client.importText(source,{overwrite:true})
 expect(writes).toEqual([{description:'Word report',body:'Word instructions',overwrite:false},{description:'Word report',body:'Word instructions'}])
})
