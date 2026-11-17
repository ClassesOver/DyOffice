import {afterEach, expect, test, vi} from 'vitest'
import {act, createElement as h} from 'react'
import {createRoot, type Root} from 'react-dom/client'
import {UserSkillsPanel} from '../../src/shell/UserSkillsPanel'
import {WEB_OFFICE_SKILL_CATALOG} from '../../src/shell/office-skill-catalog'
import {createUserSkillsClient} from '../../src/shell/user-skills-client'

;(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true
const roots:Root[]=[]
afterEach(async()=>{await act(async()=>{for(const root of roots.splice(0))root.unmount()});document.body.innerHTML='';vi.restoreAllMocks()})
async function mount(request:Parameters<typeof createUserSkillsClient>[0],onCloseGuardChange?: (guard:(()=>boolean)|null)=>void){const host=document.createElement('div');document.body.append(host);const root=createRoot(host);roots.push(root);await act(async()=>root.render(h(UserSkillsPanel,{client:createUserSkillsClient(request),onCloseGuardChange})));return host}
const button=(label:string)=>[...document.querySelectorAll('button')].find(b=>b.textContent===label)!
async function upload(file:File){await act(async()=>{const input=document.querySelector<HTMLInputElement>('input[type="file"]')!;Object.defineProperty(input,'files',{configurable:true,value:[file]});input.dispatchEvent(new Event('change',{bubbles:true}))})}
const replacementFile=()=>{const file=new File(['x'],'SKILL.md');Object.defineProperty(file,'text',{value:async()=>'---\nname: report\ndescription: Word replacement\n---\nnew Word instructions'});return file}
test('same-name file import preserves existing content until explicit replacement confirmation',async()=>{
 let body='existing Word instructions',writes=0,guard:(()=>boolean)|null=null
 await mount(async(_path,method,value)=>{if(method==='PUT'){writes++;body=(value as {body:string}).body;return {name:'report',description:'Word replacement'} as never}return [{name:'report',description:'Word report'}] as never},value=>{guard=value})
 await upload(replacementFile())
 expect(writes).toBe(0);expect(body).toBe('existing Word instructions')
 expect(document.querySelector('[role="dialog"]')?.textContent).toContain('替换同名 Skill')
 await act(async()=>expect(guard!()).toBe(false))
 const reload=new Event('beforeunload',{cancelable:true});window.dispatchEvent(reload);expect(reload.defaultPrevented).toBe(true)
 await act(async()=>button('取消替换').click());expect(writes).toBe(0);expect(guard).toBeNull()
 await upload(replacementFile());await act(async()=>button('确认替换').click())
 expect(writes).toBe(1);expect(body).toBe('new Word instructions');expect(guard).toBeNull()
 const after=new Event('beforeunload',{cancelable:true});window.dispatchEvent(after);expect(after.defaultPrevented).toBe(false)
})
test('unknown replacement retains its source and close guard without automatic resubmission',async()=>{
 let writes=0,guard:(()=>boolean)|null=null
 await mount(async(_path,method)=>{if(method==='PUT'){writes++;throw Error('lost response')}return [{name:'report',description:'Word report'}] as never},value=>{guard=value})
 await upload(replacementFile());await act(async()=>button('确认替换').click())
 expect(writes).toBe(1);expect(button('确认替换').disabled).toBe(true);expect(button('取消替换').disabled).toBe(true)
 await act(async()=>expect(guard!()).toBe(false))
 await act(async()=>button('刷新列表核对').click());expect(writes).toBe(1)
 expect(document.querySelector('[role="dialog"]')?.textContent).toContain('report')
 expect(button('确认替换').disabled).toBe(false)
 await act(async()=>button('取消替换').click());expect(guard).toBeNull();expect(writes).toBe(1)
})
test.each(['file','catalog'])('%s duplicate preflight read failure remains safely retryable without an unknown-write fence',async entry=>{
 let reads=0,writes=0,guard:(()=>boolean)|null=null
 await mount(async(_path,method)=>{if(method==='PUT'){writes++;return {} as never}if(++reads>1)throw Error('list offline');return [] as never},value=>{guard=value})
 if(entry==='file')await upload(replacementFile());else await act(async()=>button('安装').click())
 expect(writes).toBe(0);expect(guard).toBeNull()
 expect(button('导入 SKILL.md').disabled).toBe(false)
 expect(document.querySelector('[role="alert"]')?.textContent).toContain('尚未提交')
 expect(document.querySelector('[role="alert"]')?.textContent).not.toContain('结果未确认')
})

test('imports markdown through the real client and reads skill body only when viewing',async()=>{
 let imported=false;const calls:{path:string;method?:string;body?:unknown}[]=[]
 await mount(async(path,method,body)=>{calls.push({path,method,body});if(method==='PUT'){imported=true;return {name:'report',description:'Word 报告'} as never}if(path.endsWith('/report'))return {name:'report',description:'Word 报告',body:'private skill body'} as never;return (imported?[{name:'report',description:'Word 报告'}]:[]) as never})
 expect(button('导入 SKILL.md')).toBeDefined()
 const file=new File(['ignored'],'SKILL.md',{type:'text/markdown'});Object.defineProperty(file,'text',{value:async()=>'---\nname: report\ndescription: Word 报告\n---\nprivate skill body'})
 await upload(file)
 expect(calls.find(call=>call.method==='PUT')?.body).toEqual({description:'Word 报告',body:'private skill body'})
 expect(document.body.textContent).not.toContain('private skill body')
 await act(async()=>button('查看').click())
 expect(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Skill 内容"]')?.value).toBe('private skill body')
 await act(async()=>button('关闭').click())
 expect(document.querySelector('textarea[aria-label="Skill 内容"]')).toBeNull()
})

test('oversized markdown is rejected before reading or writing',async()=>{
 const request=vi.fn(async()=>[] as never);await mount(request)
 const text=vi.fn();const file=new File(['x'],'SKILL.md');Object.defineProperty(file,'size',{value:262145});Object.defineProperty(file,'text',{value:text})
 await upload(file)
 expect(document.querySelector('[role="alert"]')?.textContent).toContain('256 KiB')
 expect(text).not.toHaveBeenCalled();expect(request).toHaveBeenCalledTimes(1)
})

test('unknown deletion is not repeated before an explicit list reconciliation',async()=>{
 let deletes=0,removed=false
 await mount(async(_path,method)=>{if(method==='DELETE'){deletes++;removed=true;throw Error('lost response')}return (removed?[]:[{name:'report',description:'Word 报告'}]) as never})
 await act(async()=>button('删除').click())
 expect(deletes).toBe(0)
 await act(async()=>button('确认删除').click())
 expect(deletes).toBe(1)
 expect(document.querySelector('[role="alert"]')?.textContent).toContain('核对')
 expect(button('删除').disabled).toBe(true)
 await act(async()=>button('刷新列表').click())
 expect(document.querySelectorAll('.ant-table')[1].textContent).not.toContain('Word 报告')
 expect(deletes).toBe(1)
})

test('skill import pending and unknown result guard closing until explicit list reconciliation',async()=>{
 let guard:(()=>boolean)|null=null,finish!:(value:unknown)=>void,reject!:(error:Error)=>void
 await mount(async(_path,method)=>method==='PUT'?new Promise((_resolve,fail)=>{reject=fail}):[] as never,value=>{guard=value})
 expect(guard).toBeNull()
 const file=new File(['x'],'SKILL.md');Object.defineProperty(file,'text',{value:()=>new Promise(resolve=>{finish=resolve})})
 await upload(file)
 expect(guard).toBeTypeOf('function')
 await act(async()=>{expect(guard!()).toBe(false)})
 await act(async()=>finish('---\nname: report\ndescription: Word report\n---\nbody'))
 await act(async()=>{expect(guard!()).toBe(false)})
 await act(async()=>reject(Error('lost response')))
 await act(async()=>{expect(guard!()).toBe(false)})
 await act(async()=>button('刷新列表').click())
 expect(guard).toBeNull()
})

test('invalid local markdown never enters the unknown-write fence and remains safe to correct',async()=>{
 let guard:(()=>boolean)|null=null
 const request=vi.fn(async()=>[] as never)
 await mount(request,value=>{guard=value})
 const file=new File(['x'],'SKILL.md');Object.defineProperty(file,'text',{value:async()=>'invalid skill file'})
 await upload(file)
 expect(request).toHaveBeenCalledTimes(1)
 expect(guard).toBeNull()
 expect(button('导入 SKILL.md').disabled).toBe(false)
 expect(document.querySelector('[role="alert"]')?.textContent).toContain('name')
})

test('confirmed deletion followed by list failure reports a read failure without an unknown mutation fence',async()=>{
 let listed=0,guard:(()=>boolean)|null=null
 await mount(async(_path,method)=>{if(method==='DELETE')return undefined as never;if(++listed>1)throw Error('list unavailable');return [{name:'report',description:'Word 报告'}] as never},value=>{guard=value})
 await act(async()=>button('删除').click());await act(async()=>button('确认删除').click())
 expect(guard).toBeNull()
 expect(document.querySelector('[role="alert"]')?.textContent).toContain('列表刷新失败')
 expect(document.querySelector('[role="alert"]')?.textContent).not.toContain('结果未确认')
 expect(button('删除')).toBeUndefined()
})

test('personal records are separate from the install catalog and no built-ins are injected',async()=>{
 const host=await mount(async path=>path==='/api/v1/skills'?[{name:'html-helper',description:'HTML helper'}] as never:{name:'html-helper',description:'HTML helper',body:'Markdown finance tools'} as never)
 expect(host.querySelector('[data-office-skill]')).toBeNull()
 expect(host.textContent).not.toContain('html-helper')
 expect(host.querySelectorAll('[data-office-skill]')).toHaveLength(0)
})

test('unrelated import is a local validation failure and leaves import available',async()=>{
 let guard:(()=>boolean)|null=null
 const request=vi.fn(async()=>[] as never)
 await mount(request,value=>{guard=value})
 const file=new File(['x'],'SKILL.md');Object.defineProperty(file,'text',{value:async()=>'---\nname: html-helper\ndescription: HTML and Markdown\n---\nFinance automation'})
 await upload(file)
 expect(request).toHaveBeenCalledTimes(1)
 expect(guard).toBeNull()
 expect(button('导入 SKILL.md').disabled).toBe(false)
 expect(document.querySelector('[role="alert"]')?.textContent).toContain('仅支持 Word')
})


async function searchCatalog(host:HTMLElement,text:string){const input=host.querySelector<HTMLInputElement>('input[aria-label="搜索可安装技能"]')!;await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,text);input.dispatchEvent(new Event('input',{bubbles:true}))})}
test('catalog installation writes the selected source only after clicking and disables same-name overwrite',async()=>{
 const offered=WEB_OFFICE_SKILL_CATALOG.find(skill=>skill.key==='weekly-report')!
 let saved:{name:string;description:string;body:string}|null=null
 const calls:{path:string;method?:string;body?:unknown}[]=[]
 const host=await mount(async(path,method,body)=>{calls.push({path,method,body});if(method==='PUT'){saved={name:offered.key,...body as {description:string;body:string}};return saved as never}return (saved?[saved]:[]) as never})
 expect(calls.every(call=>!call.method)).toBe(true)
 await searchCatalog(host,offered.name)
 expect(host.querySelectorAll('.ant-table-tbody > tr[data-row-key]')).toHaveLength(1)
 await act(async()=>button('查看正文').click())
 expect(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Skill 内容"]')?.value).toContain('document tools')
 expect(calls).toHaveLength(1)
 await act(async()=>button('关闭').click());await act(async()=>button('安装').click())
 expect(calls.filter(call=>call.method==='PUT').map(call=>call.path)).toEqual(['/api/v1/skills/weekly-report'])
 expect(saved?.body).toContain('Web 工具适配')
 expect(button('已添加').disabled).toBe(true)
 expect(host.querySelectorAll('.ant-table')[1].textContent).toContain(offered.name)
})
test('catalog remains paged and unknown installation cannot be repeated until explicit reconciliation',async()=>{
 let writes=0,guard:(()=>boolean)|null=null
 const host=await mount(async(_path,method)=>{if(method==='PUT'){writes++;throw Error('lost')}return [] as never},value=>{guard=value})
 expect(host.querySelectorAll('.ant-table')[0].querySelectorAll('tr[data-row-key]')).toHaveLength(6)
 expect(host.querySelector('.ant-pagination')).not.toBeNull()
 await act(async()=>button('安装').click())
 expect(writes).toBe(1);expect(button('安装').disabled).toBe(true)
 await act(async()=>expect(guard!()).toBe(false))
 await act(async()=>button('刷新列表').click())
 expect(button('安装').disabled).toBe(false)
})
test('catalog write rejection never shows a successful installation',async()=>{
 await mount(async(_path,method)=>{if(method==='PUT')throw Object.assign(Error('denied'),{status:403});return [] as never})
 await act(async()=>button('安装').click())
 expect(button('已添加')).toBeUndefined()
 expect(document.querySelector('[role="alert"]')?.textContent).toContain('操作被拒绝')
})
