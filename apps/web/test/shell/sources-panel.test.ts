import { afterEach, expect, test } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SourcesPanel } from '../../src/shell/SourcesPanel'
import { createSourcesClient } from '../../src/shell/sources-client'
import type { SourceDetail, SaveSourceRequest } from '../../../../packages/web-contracts/src/sources'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const roots: Root[] = []
const initial = (): SourceDetail => ({ source: { sourceId: 'revenue', name: '营业收入', kind: 'postgres', version: 3, enabled: true, hasCredential: true, updatedAt: '2026-11-17T00:00:00Z' }, config: { timezone: 'UTC', maxRows: 10, units: { amount: '元' } } })
type Request = Parameters<typeof createSourcesClient>[0]
async function mount(run: (path: string, method?: string, body?: unknown) => Promise<unknown>, onCloseGuardChange?: (guard:(()=>boolean)|null)=>void, presentation?: 'page') {
 const client = createSourcesClient(run as Request), host = document.createElement('div'); document.body.append(host)
 const root = createRoot(host); roots.push(root)
 await act(async () => root.render(h(SourcesPanel, { client, onClose() {}, onCloseGuardChange, presentation })))
 const row = [...host.querySelectorAll('button')].find(button => button.textContent?.includes('营业收入'))!
 await act(async () => row.click())
 return { client, host }
}
function button(label: string) { const result = [...document.querySelectorAll('button')].find(button => button.textContent === label); expect(result, label).toBeDefined(); return result! }
async function click(label: string) { await act(async () => button(label).click()) }
function input(label: string) { const node = document.querySelector<HTMLInputElement>(`[aria-label="${label}"]`); expect(node).not.toBeNull(); return node! }
async function change(label: string, value: string) {
 await act(async () => { const node = document.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!; const select = node instanceof HTMLSelectElement
 Object.getOwnPropertyDescriptor(select ? HTMLSelectElement.prototype : node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(node, value)
 node.dispatchEvent(new Event(select ? 'change' : 'input', { bubbles: true })) })
}
afterEach(async () => { await act(async () => { for (const root of roots.splice(0)) root.unmount() }); document.body.innerHTML = '' })
function read(path: string) { return path.includes('?') ? { items: [initial().source], nextCursor: null } : initial() }

test('connection list distinguishes loading, failure and an empty successful retry',async()=>{
 let rejectList!:(reason:Error)=>void
 const pending=new Promise((_resolve,reject)=>{rejectList=reject})
 let lists=0
 const client=createSourcesClient((async()=>++lists===1?pending:{items:[],nextCursor:null}) as Request)
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);roots.push(root)
 await act(async()=>root.render(h(SourcesPanel,{client,onClose(){}})))
 expect(host.textContent).toContain('正在加载数据连接…')
 expect(host.textContent).not.toContain('尚未配置数据连接')
 await act(async()=>rejectList(Error('offline')))
 expect(host.querySelector('[role="alert"]')).not.toBeNull()
 expect(host.textContent).not.toContain('正在加载数据连接…')
 expect(host.textContent).not.toContain('尚未配置数据连接')
 await click('刷新列表')
 expect(host.textContent).toContain('尚未配置数据连接')
})

test('new connection preserves an unchecked enabled flag and reports the saved disabled state',async()=>{
 let created:Record<string,unknown>|undefined
 const current=initial();current.source.enabled=false
 const client=createSourcesClient((async(path:string,method='GET',body?:unknown)=>{
  if(method==='POST'){created=body as Record<string,unknown>;return current.source}
  return path.includes('?')?{items:created?[current.source]:[],nextCursor:null}:current
 }) as Request)
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);roots.push(root)
 await act(async()=>root.render(h(SourcesPanel,{client,onClose(){}})))
 await click('新建数据连接')
 await change('连接标识','revenue');await change('连接名称','营业收入');await change('连接凭据','postgres://test:test@db.invalid/test')
 await act(async()=>host.querySelector<HTMLInputElement>('input[aria-label="启用数据连接"]')!.click())
 await click('保存连接')
 expect(created?.enabled).toBe(false)
 expect(host.querySelector('.dc-notice--success')?.textContent).toContain('连接已保存，当前已停用。')
 expect(button('测试连接').disabled).toBe(true)
 await act(async()=>host.querySelector<HTMLInputElement>('input[aria-label="启用数据连接"]')!.click())
 expect(host.querySelector('.dc-notice--success')).toBeNull()
})

test('connection management offers save and test without query or publication controls', async()=>{
 const current=initial()
 const {host}=await mount(async path=>path.includes('?')?{items:[current.source],nextCursor:null}:current)
 expect(host.textContent).not.toMatch(/版本|发布|草稿 v/)
 expect(button('保存连接')).toBeDefined()
 expect(button('测试连接')).toBeDefined()
 expect([...host.querySelectorAll('button')].some(node=>node.textContent==='执行查询')).toBe(false)
 await change('连接名称','尚未保存')
 expect(button('测试连接').disabled).toBe(true)
})

test.each(['READONLY_ROLE_REQUIRED', 'SOURCE_TIMEOUT', 'SOURCE_UNAVAILABLE'])('failed connection test %s is presented as an error and a later success clears it', async code => {
 let ok = false
 const {host} = await mount(async (path, method = 'GET') => method === 'POST' ? {ok, code, kind: 'postgres'} : read(path))
 await click('测试连接')
 expect(host.querySelector('.dc-notice--success')).toBeNull()
 expect(host.querySelector('.dc-notice--error')?.textContent).toMatch(/未通过|超时/)
 ok = true
 await click('测试连接')
 expect(host.querySelector('.dc-notice--error')).toBeNull()
 expect(host.querySelector('.dc-notice--success')?.textContent).toContain('连接测试通过')
})

test('source management never reads back a DSN and an unchanged secret is omitted from save', async () => {
 let body: SaveSourceRequest | undefined
 await mount(async (path, method = 'GET', value) => { if (method === 'PUT') { body = value as SaveSourceRequest; return initial().source } return read(path) })
 expect(document.querySelector('[aria-label="连接凭据"]')).toBeNull()
 await change('连接名称', '新的名称'); await click('保存连接')
 expect(body?.expectedVersion).toBe(3)
 expect(body?.name).toBe('新的名称')
 expect(body).not.toHaveProperty('secret')
})

test('connection list filters before opening a standalone edit form',async()=>{
 const second={...initial().source,sourceId:'expense',name:'费用分析'}
 const {host}=await mount(async path=>path.includes('?')?{items:[initial().source,second],nextCursor:null}:initial())
 expect(host.querySelector('[aria-label="搜索数据连接"]')).toBeNull()
 await click('返回连接列表')
 await change('搜索数据连接','no matching connection')
 expect(host.querySelectorAll('.database-connection-row')).toHaveLength(0)
 expect(host.textContent).toContain('没有匹配的连接')
 await click('清除筛选')
 expect(host.querySelectorAll('.database-connection-row')).toHaveLength(2)
})

test.each([409, 503])('HTTP %i preserves edited fields, clears entered credentials and never displays raw errors', async status => {
 await mount(async (path, method = 'GET') => { if (method === 'PUT') throw Object.assign(Error('postgres://private:secret@host/db'), { status }); return read(path) })
 await change('连接名称', '保留的草稿'); await change('凭据操作', 'replace'); await change('连接凭据', 'postgres://one-use')
 await click('保存连接')
 expect(input('连接名称').value).toBe('保留的草稿')
 expect(input('连接凭据').value).toBe('')
 expect(document.body.textContent).not.toContain('private:secret')
 expect(document.querySelector('[role="alert"]')).not.toBeNull()
})

test('reading after unknown write does not unblock mutation until the server version is explicitly adopted', async () => {
 let writes = 0
 const { client } = await mount(async (path, method = 'GET') => { if (method === 'PUT') { writes++; throw Error('network') } return read(path) })
 await change('连接名称', '草稿'); await click('保存连接')
 expect(client.getState().unknownWrite).toBe(true)
 await click('读取最新配置并核对')
 expect(client.getState().unknownWrite).toBe(true)
 expect(input('连接名称').value).toBe('草稿')
 await click('采用服务器配置并放弃修改')
 expect(client.getState().unknownWrite).toBe(false)
 expect(input('连接名称').value).toBe('营业收入')
 expect(writes).toBe(1)
})

test('credential clearing is explicit null, independent of an omitted credential', async () => {
 let sent: SaveSourceRequest | undefined
 await mount(async (path, method = 'GET', body) => { if (method === 'PUT') { sent = body as SaveSourceRequest; return initial().source } return read(path) })
 await change('凭据操作', 'clear'); await click('保存连接')
 expect(sent?.secret).toBeNull()
})

test('table visibility can restrict saved tables and return explicitly to all readable tables',async()=>{
 const writes:SaveSourceRequest[]=[]
 await mount(async(path,method='GET',body)=>{if(method==='PUT'){writes.push(body as SaveSourceRequest);return initial().source}if(path.endsWith('/discover'))return {items:[],truncated:false};return read(path)})
 await change('表可见范围','selected')
 await act(async()=>{const node=document.querySelector<HTMLTextAreaElement>('[aria-label="允许访问的表"]')!;Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(node,'public.orders\npublic.items\n');node.dispatchEvent(new Event('input',{bubbles:true}))})
 await click('保存连接')
 expect(writes[0].config).toMatchObject({allowedTables:['public.orders','public.items']})
 await change('表可见范围','selected')
 await click('保存连接')
 expect(writes[1].config).toMatchObject({allowedTables:[]})
 await change('表可见范围','all')
 await click('保存连接')
 expect(writes[2].config).not.toHaveProperty('allowedTables')
})

test('a lost delete response is reconciled by a confirmed 404 without replaying deletion', async()=>{
 let removed=false,deletes=0
 const {client}=await mount(async(path,method='GET')=>{
   if(method==='DELETE'){removed=true;deletes++;throw Error('lost response')}
   if(removed&&!path.includes('?'))throw Object.assign(Error('missing'),{status:404})
   return path.includes('?')?{items:removed?[]:[initial().source],nextCursor:null}:initial()
 })
 await act(async()=>{const check=document.querySelector<HTMLInputElement>('[aria-label="确认删除此连接"]')!;check.click()})
 await click('删除连接')
 expect(client.getState().unknownWrite).toBe(true)
 await click('读取最新配置并核对')
 expect(document.body.textContent).toContain('服务器确认此连接已不存在')
 expect(client.getState().unknownWrite).toBe(true)
 await click('确认不存在并开始新建')
 expect(client.getState().unknownWrite).toBe(false)
 expect(deletes).toBe(1)
})


test('overprivileged source account is identified without echoing a target grant or secret', async()=>{
 await mount(async(path,method='GET')=>path.endsWith('/test')?{ok:false,kind:'starrocks',code:'READONLY_ROLE_REQUIRED'}:read(path))
 await click('测试连接')
 expect(document.body.textContent).toContain('账号未通过最小只读权限核验')
 expect(document.body.textContent).toContain('不能使用 root 或管理角色')
})

test('new session key discards old pending list and never repopulates its source draft', async () => {
 let resolveOld!: (value: unknown) => void
 const oldList = new Promise(resolve=>{resolveOld=resolve})
 const oldClient=createSourcesClient((async()=>oldList) as Request)
 const nextClient=createSourcesClient((async()=>({items:[],nextCursor:null})) as Request)
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);roots.push(root)
 await act(async()=>root.render(h(SourcesPanel,{key:'alice',client:oldClient,onClose(){}})))
 await act(async()=>root.render(h(SourcesPanel,{key:'bob',client:nextClient,onClose(){}})))
 await act(async()=>resolveOld({items:[initial().source],nextCursor:null}))
 expect(host.textContent).not.toContain('营业收入')
 expect(host.querySelector('[aria-label="连接凭据"]')).toBeNull()
})

test('friendly timezone and row-limit fields save public configuration while preserving advanced units',async()=>{
 let saved:SaveSourceRequest|undefined
 await mount(async(path,method='GET',body)=>{if(method==='PUT'){saved=body as SaveSourceRequest;return initial().source}return read(path)})
 expect(document.querySelector('[aria-label="时区"]')).not.toBeNull()
 await change('时区','Asia/Shanghai')
 await change('查询最大行数','250')
 await click('保存连接')
 expect(saved?.config).toEqual({timezone:'Asia/Shanghai',maxRows:250,units:{amount:'元'}})
 expect(document.querySelector('details summary')?.textContent).toContain('高级配置')
})

test('the per-connection statement timeout is editable and clearing it restores the default',async()=>{
 const saves:SaveSourceRequest[]=[]
 await mount(async(path,method='GET',body)=>{if(method==='PUT'){saves.push(body as SaveSourceRequest);return initial().source}return read(path)})
 await change('查询超时毫秒数','20000')
 await click('保存连接')
 expect(saves.at(-1)?.config).toMatchObject({statementTimeoutMs:20000})
 await change('查询超时毫秒数','')
 await click('保存连接')
 expect(saves.at(-1)?.config).not.toHaveProperty('statementTimeoutMs')
 // Out of range is caught before the request, with the field's own hint.
 const count=saves.length
 await change('查询超时毫秒数','60000')
 await click('保存连接')
 expect(saves.length).toBe(count)
 expect(document.body.textContent).toContain('100–30000 毫秒')
})

test('restoring original source values releases the dirty close guard',async()=>{
 let guard:(()=>boolean)|null=null
 await mount(async path=>read(path),value=>{guard=value})
 expect(guard).toBeNull()
 await change('连接名称','临时名称');expect(guard).toBeTypeOf('function')
 await change('连接名称','营业收入');expect(guard).toBeNull()
 expect(document.body.textContent).not.toContain('当前有未保存连接')
})

test('new data connections default to PostgreSQL and offer only supported database connectors',async()=>{
 let created:unknown
 const client=createSourcesClient((async(path:string,method='GET',body?:unknown)=>{if(method==='POST'){created=body;return initial().source}return path.includes('?')?{items:[],nextCursor:null}:initial()}) as Request)
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);roots.push(root)
 await act(async()=>root.render(h(SourcesPanel,{client,onClose(){}})))
 expect(host.textContent).toContain('数据连接')
 await click('新建数据连接')
 expect(input('连接器').value).toBe('postgres')
 expect([...document.querySelectorAll('[aria-label="连接器"] option')].map(node=>node.textContent)).toEqual(['PostgreSQL','MySQL','StarRocks'])
 await change('连接标识','qa_database');await change('连接名称','QA数据库');await change('连接凭据','postgres://qa:qa@db.example/qa')
 await click('保存连接')
 expect(created).toMatchObject({kind:'postgres',sourceId:'qa_database',secret:'postgres://qa:qa@db.example/qa'})
})

test('legacy HTTP connections remain visible but cannot be edited or deleted',async()=>{
 let mutations=0,query:unknown
 const legacy:SourceDetail={...initial(),source:{...initial().source,kind:'http'}}
 await mount(async(path,method='GET',body)=>{
  if(path.endsWith('/query')){query=body;return {version:1,sourceId:'revenue',sourceVersion:1,timezone:'UTC',schema:[],rows:[],truncated:false,sha256:'b'.repeat(64)}}
  if(method!=='GET')mutations++
  return path.includes('?')?{items:[legacy.source],nextCursor:null}:legacy
 })
 expect(document.body.textContent).toContain('HTTP 连接仅支持只读查看')
 expect(input('连接名称').disabled).toBe(true)
 expect(button('保存连接').disabled).toBe(true)
 expect([...document.querySelectorAll('button')].some(node=>node.textContent==='发布草稿')).toBe(false)
 expect(button('删除连接').disabled).toBe(true)
 expect(document.querySelector('[aria-label="连接凭据"]')).toBeNull()
 expect(mutations).toBe(0)
})

test('refreshing a source list preserves credentials that have not been submitted',async()=>{
 await mount(async path=>read(path))
 await change('凭据操作','replace');await change('连接凭据','UNSUBMITTED-MOCK')
 expect(document.querySelector('[aria-label="搜索数据连接"]')).toBeNull()
 expect(input('连接凭据').value).toBe('UNSUBMITTED-MOCK')
})
test('dirty source drafts block browser unload without opening a second confirmation',async()=>{
 await mount(async path=>read(path));await change('连接名称','未保存')
 const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event)
 expect(event.defaultPrevented).toBe(true)
 await change('连接名称','营业收入')
 const clean=new Event('beforeunload',{cancelable:true});window.dispatchEvent(clean)
 expect(clean.defaultPrevented).toBe(false)
})

test('an unknown save on A survives browsing and adopting B until A is read and adopted',async()=>{
 const a=initial(),b={...initial(),source:{...initial().source,sourceId:'other',name:'另一连接'}}
 let saves=0
 const {client}=await mount(async(path,method='GET')=>{if(method==='PUT'){saves++;throw Error('lost response')}if(path.includes('?'))return {items:[a.source,b.source],nextCursor:null};return path.endsWith('/other')?b:a})
 await click('保存连接');expect(client.getState().unknownWrite).toBe(true)
 await click('返回连接列表')
 await act(async()=>{[...document.querySelectorAll<HTMLButtonElement>('.database-connection-name')].find(node=>node.textContent?.includes('另一连接'))!.click()})
 expect(input('连接名称').value).toBe('另一连接')
 await click('读取最新配置并核对');await click('采用服务器配置并放弃修改')
 expect(client.getState().unknownWrite).toBe(true)
 expect(button('保存连接').disabled).toBe(true)
 await click('返回连接列表')
 await act(async()=>{[...document.querySelectorAll<HTMLButtonElement>('.database-connection-name')].find(node=>node.textContent?.includes('营业收入'))!.click()})
 await click('读取最新配置并核对');await click('采用服务器配置并放弃修改')
 expect(client.getState().unknownWrite).toBe(false);expect(button('保存连接').disabled).toBe(false);expect(saves).toBe(1)
})

test('the affected identity remains directly reconcilable after browsing B and refreshing away deleted A',async()=>{
 const a=initial(),b={...initial(),source:{...initial().source,sourceId:'other',name:'另一连接'}};let deleted=false
 const {client}=await mount(async(path,method='GET')=>{if(method==='DELETE'){deleted=true;throw Error('lost')}if(path.includes('?'))return {items:deleted?[b.source]:[a.source,b.source],nextCursor:null};if(deleted&&path.endsWith('/revenue'))throw Object.assign(Error('missing'),{status:404});return path.endsWith('/other')?b:a})
 await act(async()=>document.querySelector<HTMLInputElement>('[aria-label="确认删除此连接"]')!.click());await click('删除连接')
 await click('返回连接列表')
 await act(async()=>{[...document.querySelectorAll<HTMLButtonElement>('.database-connection-name')].find(node=>node.textContent?.includes('另一连接'))!.click()});await click('返回连接列表');await click('刷新列表')
 expect(document.querySelectorAll('.database-connection-row').length).toBe(1)
 await click('读取待核对连接（revenue）');await click('确认不存在并开始新建')
 expect(client.getState().unknownWrite).toBe(false)
})

test.each(['dialog','page'] as const)('a failed initial source list is announced before the %s controls and can be refreshed',async presentation=>{
 let failed=true,writes=0
 const client=createSourcesClient((async(_path:string,method='GET')=>{if(method!=='GET')writes++;if(failed)throw Object.assign(Error('private backend failure'),{status:503});return {items:[initial().source],nextCursor:null}}) as Request)
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);roots.push(root)
 await act(async()=>root.render(h(SourcesPanel,{client,presentation,onClose(){}})))
 const error=host.querySelector('.dc-notice--error')!
 expect(error.textContent).toContain('暂不可用')
 expect(error.textContent).not.toContain('private backend failure')
 expect(error.compareDocumentPosition(host.querySelector('.database-connections-list')!)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
 failed=false;await click('刷新列表')
 expect(host.querySelector('.dc-notice--error')).toBeNull()
 expect(host.querySelector('.database-connection-name')?.textContent).toContain('营业收入')
 expect(writes).toBe(0)
})

test('connection management uses a list-first layout with standalone grouped editing and no query entry', async () => {
 const {host} = await mount(async path => read(path))
 expect(host.querySelector('.database-connections')).not.toBeNull()
 expect(host.querySelector('.source-body,.sources-panel-b')).toBeNull()
 expect(host.querySelector('.database-connections-list')).toBeNull()
 expect([...host.querySelectorAll('fieldset legend')].map(node=>node.textContent)).toEqual(['基础信息','凭据','可见目录与表','高级配置'])
 expect(host.querySelector('.database-connections-actions')).not.toBeNull()
 expect(button('返回连接列表')).toBeDefined()
 expect(host.textContent).not.toMatch(/数据查询|执行查询|前往查询|打开查询/)
})

test('leaving an edited form asks before dropping changes and clears entered credentials',async()=>{
 const {host}=await mount(async path=>read(path))
 await change('凭据操作','replace');await change('连接凭据','TEMP-SECRET')
 const original=window.confirm;window.confirm=()=>false
 try {await click('返回连接列表');expect(input('连接凭据').value).toBe('TEMP-SECRET')
 window.confirm=()=>true;await click('返回连接列表')
 expect(host.querySelector('[aria-label="连接凭据"]')).toBeNull()
 await act(async()=>host.querySelector<HTMLButtonElement>('.database-connection-name')!.click())
 expect(host.querySelector('[aria-label="连接凭据"]')).toBeNull()
 } finally {window.confirm=original}
})

test('initial management view uses native controls and shows credentials and enabled state before editing',async()=>{
 const client=createSourcesClient((async(path:string)=>read(path)) as Request)
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);roots.push(root)
 await act(async()=>root.render(h(SourcesPanel,{client,onClose(){}})))
 expect(host.querySelector('.database-connections-list')).not.toBeNull()
 expect(host.querySelector('.database-connections-form')).toBeNull()
 expect(host.querySelectorAll('[class*="ant-"]')).toHaveLength(0)
 expect(host.querySelector('.database-connection-row')?.textContent).toContain('已启用')
 expect(host.querySelector('.database-connection-row')?.textContent).toContain('已配置')
 expect(host.querySelector('[aria-label="编辑连接 营业收入"]')).not.toBeNull()
 await click('新建数据连接')
 expect(host.querySelector('.database-connections-list')).toBeNull()
 expect(host.querySelector('select[aria-label="连接器"]')).not.toBeNull()
 expect(host.querySelector('select[aria-label="表可见范围"]')).not.toBeNull()
 expect(host.querySelector('textarea[aria-label="允许访问的表"]')).not.toBeNull()
 expect(host.querySelector('input[type="password"][aria-label="连接凭据"]')).not.toBeNull()
 expect(host.querySelectorAll('[class*="ant-"]')).toHaveLength(0)
})

test('connection scope sends the database, schema and table restrictions independently', async () => {
 let body: SaveSourceRequest | undefined
 await mount(async (path, method = 'GET', value) => {
  if (method === 'PUT') { body = value as SaveSourceRequest; return initial().source }
  return read(path)
 })
 await change('数据库名称','reporting')
 await change('目录范围','selected')
 await change('允许访问的目录','sales\nfinance')
 await change('表可见范围','selected')
 await change('允许访问的表','sales.orders\n')
 await click('保存连接')
 expect(body?.config).toMatchObject({database:'reporting',allowedSchemas:['sales','finance'],allowedTables:['sales.orders']})
 expect(body).not.toHaveProperty('secret')
})

test('reads saved connection directories and tables and saves the selected whitelist', async () => {
 let body: SaveSourceRequest | undefined
 const probes:unknown[]=[]
 await mount(async (path, method = 'GET', value) => {
  if (method === 'PUT') { body = value as SaveSourceRequest; return initial().source }
  if (path.endsWith('/discover')) {
   probes.push(value)
   return {items: probes.length === 1 ? ['sales'] : ['orders'],truncated:false}
  }
  return read(path)
 })
 await click('读取目录和表')
 expect(probes).toEqual([{expectedVersion:3},{expectedVersion:3,directory:'sales'}])
 await change('目录范围','selected')
 const select = (name:string)=>document.querySelector<HTMLInputElement>(`input[aria-label="${name}"]`)!
 await act(async()=>select('允许目录 sales').click())
 await change('表可见范围','selected')
 await act(async()=>select('允许表 sales.orders').click())
 await click('保存连接')
 expect(body?.config).toMatchObject({allowedSchemas:['sales'],allowedTables:['sales.orders']})
})

test('save and test guides the user to searchable directory and table selection', async () => {
 let saved = initial()
 const {host}=await mount(async (path, method = 'GET', body) => {
  if (path.endsWith('/test')) {
   expect(saved.source.name).toBe('报表')
   return {ok:true,kind:'postgres'}
  }
  if (path.endsWith('/discover')) return {items:(body as {directory?:string}).directory?['orders','items']:['sales','finance'],truncated:false}
  if (method==='PUT') {
   const value=body as SaveSourceRequest
   saved={source:{...saved.source,version:saved.source.version+1,name:value.name!},config:value.config!}
   return saved.source
  }
  return path.includes('?')?{items:[saved.source],nextCursor:null}:saved
 },undefined,'page')
 await change('连接名称','报表')
 await click('保存并测试')
 await click('选择可见范围')
 expect(host.querySelector('#dc-tab-scope')?.getAttribute('aria-selected')).toBe('true')
 await change('搜索目录','sale')
 expect(host.querySelector('[aria-label="可选目录"]')?.textContent).not.toContain('finance')
 await change('目录范围','selected')
 await act(async()=>input('允许目录 sales').click())
 await click('浏览 sales 的表')
 await change('搜索表','order')
 expect(host.querySelector('[aria-label="可选表"]')?.textContent).not.toContain('items')
 await change('表可见范围','selected')
 await act(async()=>input('允许表 sales.orders').click())
 expect(host.textContent).toContain('已选 1 个目录、1 张表')
 expect(saved.config).not.toHaveProperty('allowedTables')
 await click('保存连接')
 expect(saved.config).toMatchObject({allowedSchemas:['sales'],allowedTables:['sales.orders']})
})

test('failed connection testing confirms the save and explains the next action', async()=>{
 let saved=false
 const {host}=await mount(async (path,method='GET')=>{
  if(method==='PUT'){saved=true;return initial().source}
  if(path.endsWith('/test')){expect(saved).toBe(true);return {ok:false,code:'TARGET_NOT_APPROVED',kind:'postgres'}}
  return read(path)
 },undefined,'page')
 await click('保存并测试')
 expect(host.querySelector('[role="alert"]')?.textContent).toContain('连接已保存，但测试未通过')
 expect(host.querySelector('[role="alert"]')?.textContent).toContain('全局配置')
})

test('scope review retains picks across directory changes and preserves an empty restriction when removing the last table',async()=>{
 let saved=initial()
 const {host}=await mount(async(path,method='GET',body)=>{
  if(method==='PUT'){
   saved={source:{...saved.source,version:saved.source.version+1},config:(body as SaveSourceRequest).config!}
   return saved.source
  }
  if(path.endsWith('/discover')){
   const directory=(body as {directory?:string}).directory
   return {items:directory?['orders']:['sales','finance'],truncated:false}
  }
  return path.includes('?')?{items:[saved.source],nextCursor:null}:saved
 },undefined,'page')
 await click('可见范围')
 await click('读取目录和表')
 await change('表可见范围','selected')
 expect(host.textContent).toContain('尚未选择表，保存后助手将看不到任何表。')
 await click('浏览 sales 的表')
 await act(async()=>input('允许表 sales.orders').click())
 await click('浏览 finance 的表')
 await change('搜索表','no match')
 const remove=host.querySelector<HTMLButtonElement>('button[aria-label="移除表 sales.orders"]')!
 expect(remove).not.toBeNull()
 expect(remove.closest('details')?.open).toBe(true)
 await act(async()=>remove.click())
 expect(host.textContent).toContain('尚未选择表，保存后助手将看不到任何表。')
 await click('保存连接')
 expect(saved.config.allowedTables).toEqual([])
})

test('bulk table actions only affect the filtered tables in the current directory',async()=>{
 const detail=initial()
 detail.config={...detail.config,allowedTables:['archive.orders','orders','public.payments']}
 let saved:SaveSourceRequest|undefined
 await mount(async(path,method='GET',body)=>{
  if(method==='PUT'){saved=body as SaveSourceRequest;return detail.source}
  if(path.endsWith('/discover'))return {items:(body as {directory?:string}).directory?['orders','orders_2026','payments']:['public'],truncated:false}
  return path.includes('?')?{items:[detail.source],nextCursor:null}:detail
 },undefined,'page')
 await click('可见范围')
 await click('读取目录和表')
 await click('浏览 public 的表')
 await change('搜索表','orders')
 await click('勾选搜索结果（2）')
 expect(input('允许表 public.orders_2026').checked).toBe(true)
 expect(document.querySelector('[aria-label="已选表"]')?.children.length).toBe(4)
 await click('取消勾选搜索结果（2）')
 expect(input('允许表 public.orders').checked).toBe(false)
 await click('保存连接')
 expect(saved?.config).toMatchObject({allowedTables:['archive.orders','public.payments']})
})

test('bulk table selection explains when the filtered result exceeds the remaining allowance',async()=>{
 const detail=initial()
 detail.config={...detail.config,allowedTables:Array.from({length:255},(_,index)=>'archive.table_'+index)}
 const {host}=await mount(async(path,_method,body)=>path.endsWith('/discover')
  ? {items:(body as {directory?:string}).directory?['orders','orders_2026']:['public'],truncated:false}
  : path.includes('?')?{items:[detail.source],nextCursor:null}:detail,undefined,'page')
 await click('可见范围')
 await click('读取目录和表')
 await click('浏览 public 的表')
 await change('搜索表','orders')
 expect(button('勾选搜索结果（2）').disabled).toBe(true)
 expect(host.textContent).toContain('最多可选 256 张表')
 await change('搜索表','orders_2026')
 expect(button('勾选搜索结果（1）').disabled).toBe(false)
})

test('the table picker lets the user explicitly allow its directory without losing the search or selected tables',async()=>{
 const detail=initial()
 detail.config={...detail.config,allowedSchemas:['finance'],allowedTables:[]}
 let saved:SaveSourceRequest|undefined
 const {host}=await mount(async(path,method='GET',body)=>{
  if(method==='PUT'){saved=body as SaveSourceRequest;return detail.source}
  if(path.endsWith('/discover'))return {items:(body as {directory?:string}).directory?['orders','items']:['sales','finance'],truncated:false}
  return path.includes('?')?{items:[detail.source],nextCursor:null}:detail
 },undefined,'page')
 await click('可见范围')
 await click('读取目录和表')
 await click('浏览 sales 的表')
 await change('搜索表','orders')
 await act(async()=>input('允许表 sales.orders').click())
 expect(input('允许目录 sales').checked).toBe(false)
 await click('允许此目录')
 expect(input('允许目录 sales').checked).toBe(true)
 expect(input('搜索表').value).toBe('orders')
 expect(input('允许表 sales.orders').checked).toBe(true)
 expect(host.textContent).not.toContain('此目录尚未选中')
 expect(saved).toBeUndefined()
 await click('保存连接')
 expect(saved?.config).toMatchObject({allowedSchemas:['finance','sales'],allowedTables:['sales.orders']})
})

test('a connection with unrestricted tables can switch to checkbox selection inside the picker',async()=>{
 let saved:SaveSourceRequest|undefined
 await mount(async(path,method='GET',body)=>{
  if(method==='PUT'){saved=body as SaveSourceRequest;return initial().source}
  if(path.endsWith('/discover'))return {items:(body as {directory?:string}).directory?['orders','items']:['public'],truncated:false}
  return read(path)
 },undefined,'page')
 await click('可见范围')
 await click('读取目录和表')
 await click('浏览 public 的表')
 await change('搜索表','orders')
 await click('改为勾选指定表')
 expect(input('搜索表').value).toBe('orders')
 await act(async()=>input('允许表 public.orders').click())
 expect(saved).toBeUndefined()
 await click('保存连接')
 expect(saved?.config).toMatchObject({allowedTables:['public.orders']})
})

test('directory bulk selection is available without typing a search and clearing a search preserves selections',async()=>{
 const detail=initial()
 detail.config={...detail.config,allowedTables:['archive.orders']}
 await mount(async(path,_method,body)=>path.endsWith('/discover')
  ? {items:(body as {directory?:string}).directory?['orders','payments']:['public'],truncated:false}
  : path.includes('?')?{items:[detail.source],nextCursor:null}:detail,undefined,'page')
 await click('可见范围')
 await click('读取目录和表')
 await click('浏览 public 的表')
 await click('勾选当前目录（2）')
 expect(input('允许表 public.orders').checked).toBe(true)
 expect(input('允许表 public.payments').checked).toBe(true)
 await change('搜索表','unmatched')
 await click('清除表搜索')
 expect(document.activeElement).toBe(input('搜索表'))
 expect(input('允许表 public.payments').checked).toBe(true)
 await click('取消勾选当前目录（2）')
 expect(input('允许表 public.orders').checked).toBe(false)
 expect(document.querySelector('[aria-label="已选表"]')?.textContent).toContain('archive.orders')
})

test('reading a single directory opens its tables without selecting any',async()=>{
 const detail=initial()
 detail.config={...detail.config,allowedTables:[]}
 const requests:unknown[]=[]
 const {host}=await mount(async(path,_method,body)=>{
  if(path.endsWith('/discover')){
   requests.push(body)
   return {items:(body as {directory?:string}).directory?['orders']:['public'],truncated:false}
  }
  return path.includes('?')?{items:[detail.source],nextCursor:null}:detail
 },undefined,'page')
 await click('可见范围')
 await click('读取目录和表')
 expect(requests).toEqual([{expectedVersion:3},{expectedVersion:3,directory:'public'}])
 expect(input('允许表 public.orders').checked).toBe(false)
 expect(host.querySelector<HTMLDetailsElement>('details[aria-label="目录 public 的表"]')?.open).toBe(true)
})

test('a failed automatic table read keeps the directory available for retry',async()=>{
 let attempts=0
 const {host}=await mount(async(path,_method,body)=>{
  if(path.endsWith('/discover')){
   if(!(body as {directory?:string}).directory)return {items:['public'],truncated:false}
   if(++attempts===1)throw Object.assign(Error('service unavailable'),{status:503})
   return {items:['orders'],truncated:false}
  }
  return read(path)
 },undefined,'page')
 await click('可见范围')
 await click('读取目录和表')
 expect(host.querySelector('[role="alert"]')?.textContent).toContain('未能自动读取 public 的表')
 await click('浏览 public 的表')
 expect(host.querySelector('[aria-label="可选表"]')?.textContent).toContain('orders')
 expect(host.querySelector('[role="alert"]')).toBeNull()
})

test('catalog discovery shows which step is loading until the tables arrive',async()=>{
 let finishDirectories!:(value:unknown)=>void
 let finishTables!:(value:unknown)=>void
 const directories=new Promise(resolve=>{finishDirectories=resolve})
 const tables=new Promise(resolve=>{finishTables=resolve})
 const {host}=await mount(async(path,_method,body)=>path.endsWith('/discover')
  ? (body as {directory?:string}).directory?tables:directories
  : read(path),undefined,'page')
 await click('可见范围')
 await click('读取目录和表')
 expect(host.textContent).toContain('正在读取目录…')
 expect(button('读取目录和表').matches(':disabled')).toBe(true)
 await act(async()=>finishDirectories({items:['public'],truncated:false}))
 expect(host.textContent).toContain('正在读取 public 的表…')
 await act(async()=>finishTables({items:['orders'],truncated:false}))
 expect(host.textContent).not.toContain('正在读取')
 expect(host.querySelector('[aria-label="可选表"]')?.textContent).toContain('orders')
})

test('a denied directory read points to the connection test without changing the saved configuration',async()=>{
 let writes=0
 const {host}=await mount(async(path,method)=>{
  if(method==='PUT')writes++
  if(path.endsWith('/discover'))throw Object.assign(Error('private failure'),{status:403})
  if(path.endsWith('/test'))return {ok:false,kind:'postgres',code:'READONLY_ROLE_REQUIRED'}
  return read(path)
 },undefined,'page')
 await click('可见范围')
 await click('读取目录和表')
 expect(host.querySelector('.dc-discovery [role="alert"]')?.textContent).toContain('无法读取目录')
 await click('测试连接并查看原因')
 expect(host.textContent).toContain('账号未通过最小只读权限核验')
 expect(host.textContent).not.toContain('private failure')
 expect(writes).toBe(0)
})

test('the scope tab explains that replacement credentials must be saved and links back to connection settings',async()=>{
 let reads=0
 const {host}=await mount(async path=>{if(path.endsWith('/discover'))reads++;return read(path)},undefined,'page')
 await change('凭据操作','replace')
 await change('连接凭据','postgresql://reader:test-only@db.example/sales')
 await click('可见范围')
 expect(button('读取目录和表').disabled).toBe(true)
 expect(host.textContent).toContain('连接凭据有未保存的更改')
 await click('前往连接设置')
 expect(host.querySelector('#dc-tab-connection')?.getAttribute('aria-selected')).toBe('true')
 expect(input('连接凭据').value).toContain('db.example/sales')
 expect(reads).toBe(0)
})

test('selected tables outside the allowed directories are identified without being removed',async()=>{
 const detail=initial()
 detail.config={...detail.config,allowedTables:['orders','sales.items'],allowedSchemas:['sales']}
 const {host}=await mount(async path=>path.includes('?')?{items:[detail.source],nextCursor:null}:detail,undefined,'page')
 await click('可见范围')
 const picks=host.querySelector('[aria-label="已选表"]')!
 expect(picks.querySelector('button[aria-label="移除表 orders"]')?.closest('li')?.textContent).toContain('目录未开放')
 expect(picks.querySelector('button[aria-label="移除表 sales.items"]')?.closest('li')?.textContent).not.toContain('目录未开放')
 expect(host.textContent).toContain('有 1 张已选表不在允许的目录内')
 await change('目录范围','all')
 expect(picks.textContent).not.toContain('目录未开放')
 expect(picks.querySelectorAll('li')).toHaveLength(2)
})

test('connection tabs support keyboard navigation and only the active tab is in the tab order',async()=>{
 const {host}=await mount(async path=>read(path),undefined,'page')
 const current=host.querySelector<HTMLButtonElement>('#dc-tab-connection')!
 const scope=host.querySelector<HTMLButtonElement>('#dc-tab-scope')!
 const advanced=host.querySelector<HTMLButtonElement>('#dc-tab-advanced')!
 expect([current.tabIndex,scope.tabIndex,advanced.tabIndex]).toEqual([0,-1,-1])
 const key=async (node:HTMLElement,key:string)=>act(async()=>node.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true})))
 current.focus()
 await key(current,'ArrowRight')
 expect(scope.getAttribute('aria-selected')).toBe('true')
 expect(document.activeElement).toBe(scope)
 await key(scope,'End')
 expect(advanced.getAttribute('aria-selected')).toBe('true')
 expect(document.activeElement).toBe(advanced)
 await key(advanced,'ArrowRight')
 expect(document.activeElement).toBe(current)
})

test('clearing a directory search restores the catalog without refetching or closing the selected directory',async()=>{
 let requests=0
 const {host}=await mount(async(path,_method,body)=>{
  if(path.endsWith('/discover')){
   requests++
   return {items:(body as {directory?:string}).directory?['orders']:['sales','finance'],truncated:false}
  }
  return read(path)
 },undefined,'page')
 await click('可见范围')
 await click('读取目录和表')
 await click('浏览 sales 的表')
 await change('搜索目录','nomatch')
 await click('清除目录搜索')
 expect(document.activeElement).toBe(input('搜索目录'))
 expect(host.querySelector('[aria-label="可选目录"]')?.textContent).toContain('finance')
 expect(host.querySelector('[aria-label="目录 sales 的表"]')?.textContent).toContain('orders')
 expect(requests).toBe(2)
})

test('switching back to a recently opened directory reuses its tables until the catalog is refreshed',async()=>{
 const requests:unknown[]=[]
 const {host}=await mount(async(path,_method,body)=>{
  if(path.endsWith('/discover')){
   const directory=(body as {directory?:string}).directory
   requests.push(directory)
   return {items:directory?[directory+'_orders']:['sales','finance'],truncated:false}
  }
  return read(path)
 },undefined,'page')
 await click('可见范围')
 await click('读取目录和表')
 await click('浏览 sales 的表')
 await click('浏览 finance 的表')
 await click('浏览 sales 的表')
 expect(host.querySelector('[aria-label="可选表"]')?.textContent).toContain('sales_orders')
 expect(button('浏览 sales 的表').getAttribute('aria-current')).toBe('true')
 expect(button('浏览 finance 的表').getAttribute('aria-current')).toBeNull()
 expect(requests).toEqual([undefined,'sales','finance'])
 await click('重新读取目录和表')
 await click('浏览 sales 的表')
 expect(requests).toEqual([undefined,'sales','finance',undefined,'sales'])
})

test('saving scope keeps the table browser open using the new connection version',async()=>{
 let detail=initial()
 const requests:unknown[]=[]
 const {host}=await mount(async(path,method='GET',body)=>{
  if(method==='PUT'){
   detail={source:{...detail.source,version:detail.source.version+1},config:(body as SaveSourceRequest).config!}
   return detail.source
  }
  if(path.endsWith('/discover')){
   requests.push(body)
   return {items:(body as {directory?:string}).directory?['orders','items']:['sales','finance'],truncated:false}
  }
  return path.includes('?')?{items:[detail.source],nextCursor:null}:detail
 },undefined,'page')
 await click('可见范围')
 await click('读取目录和表')
 await click('浏览 sales 的表')
 await change('搜索表','orders')
 await change('表可见范围','selected')
 await act(async()=>input('允许表 sales.orders').click())
 await click('保存连接')
 expect(requests.slice(-2)).toEqual([{expectedVersion:4},{expectedVersion:4,directory:'sales'}])
 expect(host.querySelector('[aria-label="目录 sales 的表"]')).not.toBeNull()
 expect(input('搜索表').value).toBe('orders')
 expect(input('允许表 sales.orders').checked).toBe(true)
})

test('a list refresh failure after saving does not stop the connection test',async()=>{
 let saved=initial(),writes=0,checks=0
 const {host}=await mount(async(path,method,body)=>{
  if(method==='PUT'){
   writes++
   saved={...saved,source:{...saved.source,name:(body as SaveSourceRequest).name!}}
   return saved.source
  }
  if(path.endsWith('/test')){checks++;return {ok:true,kind:'postgres'}}
  if(path.includes('?')){
   if(writes)throw Object.assign(Error('list unavailable'),{status:503})
   return {items:[saved.source],nextCursor:null}
  }
  return saved
 },undefined,'page')
 await change('连接名称','已更新')
 await click('保存并测试')
 expect(host.textContent).toContain('连接已保存，测试通过。')
 expect(input('连接名称').value).toBe('已更新')
 expect(checks).toBe(1)
 await click('返回连接列表')
 expect(host.textContent).toContain('数据连接列表未能加载，请刷新列表重试。')
 expect(writes).toBe(1)
})

test('invalid connection URLs are explained at the credential field before saving',async()=>{
 let writes=0
 const {host}=await mount(async(path,method)=>{if(method==='PUT')writes++;return read(path)},undefined,'page')
 await change('凭据操作','replace')
 await change('连接凭据','mysql://reader:fixture-secret@db.example/sales')
 await click('保存并测试')
 expect(host.querySelector('[aria-invalid="true"]')).toBe(input('连接凭据'))
 expect(host.textContent).toContain('连接地址应以 postgresql:// 开头')
 expect(host.textContent).not.toContain('fixture-secret')
 await change('连接凭据','postgresql://reader:fixture-secret@db.example')
 await click('保存并测试')
 expect(host.textContent).toContain('请在连接地址末尾填写数据库名')
 expect(input('连接凭据').value).toContain('fixture-secret')
 expect(writes).toBe(0)
})

test('scope guidance opens the input directly when the saved connection has no credential',async()=>{
 const detail=initial()
 detail.source.hasCredential=false
 await mount(async path=>path.includes('?')?{items:[detail.source],nextCursor:null}:detail,undefined,'page')
 await click('可见范围')
 await click('前往连接设置')
 expect(input('凭据操作').value).toBe('replace')
 expect(document.activeElement).toBe(input('连接凭据'))
})

test('a pending connection test is announced until the result arrives',async()=>{
 let finish!:(value:unknown)=>void
 const response=new Promise(resolve=>{finish=resolve})
 const {host}=await mount(async path=>path.endsWith('/test')?response:read(path),undefined,'page')
 await click('测试连接')
 expect(host.querySelector('.database-connections-actions [role="status"]')?.textContent).toContain('正在测试连接…')
 await act(async()=>finish({ok:true,kind:'postgres'}))
 expect(host.textContent).toContain('连接测试通过。')
 expect(host.textContent).not.toContain('正在测试连接…')
})

test('selected-only view filters tables without removing other picks',async()=>{
 const detail=initial()
 detail.config={...detail.config,allowedTables:['sales.orders','finance.payments']}
 const {host}=await mount(async(path,_method,body)=>path.endsWith('/discover')
  ? {items:(body as {directory?:string}).directory?['orders','items']:['sales'],truncated:false}
  : path.includes('?')?{items:[detail.source],nextCursor:null}:detail,undefined,'page')
 await click('可见范围')
 await click('读取目录和表')
 await act(async()=>input('只看已选表').click())
 expect(host.querySelector('[aria-label="可选表"]')?.textContent).not.toContain('items')
 expect(host.querySelector('[aria-label="已选表"]')?.textContent).toContain('finance.payments')
 await change('搜索表','items')
 expect(host.textContent).toContain('没有匹配的已选表')
 await act(async()=>input('只看已选表').click())
 expect(input('允许表 sales.items').checked).toBe(false)
})

test('restoring saved scope preserves unsaved connection and advanced fields',async()=>{
 const detail=initial()
 detail.config={...detail.config,allowedTables:['sales.orders']}
 let saved:SaveSourceRequest|undefined
 await mount(async(path,method,body)=>{
  if(method==='PUT'){saved=body as SaveSourceRequest;return detail.source}
  return path.includes('?')?{items:[detail.source],nextCursor:null}:detail
 },undefined,'page')
 await change('连接名称','新名称')
 await change('查询最大行数','20')
 await click('可见范围')
 await change('目录范围','selected')
 await change('表可见范围','all')
 await click('恢复已保存的目录和表')
 expect(input('表可见范围').value).toBe('selected')
 expect(input('目录范围').value).toBe('all')
 expect(saved).toBeUndefined()
 await click('保存连接')
 expect(saved?.name).toBe('新名称')
 expect(saved?.config).toMatchObject({allowedTables:['sales.orders'],maxRows:20})
 expect(saved?.config).not.toHaveProperty('allowedSchemas')
})

test('selection limits prevent individual additions while allowing removals',async()=>{
 const detail=initial()
 detail.config={...detail.config,allowedTables:['public.orders',...Array.from({length:255},(_,index)=>'archive.table_'+index)]}
 const {host}=await mount(async(path,_method,body)=>path.endsWith('/discover')
  ? {items:(body as {directory?:string}).directory?['orders','items']:['public'],truncated:false}
  : path.includes('?')?{items:[detail.source],nextCursor:null}:detail,undefined,'page')
 await click('可见范围')
 await click('读取目录和表')
 expect(input('允许表 public.items').disabled).toBe(true)
 expect(input('允许表 public.orders').disabled).toBe(false)
 expect(host.textContent).toContain('已达到 256 张表的上限')
 await act(async()=>input('允许表 public.orders').click())
 expect(input('允许表 public.items').disabled).toBe(false)
})

test('a failed table read retries only the requested directory and keeps existing picks',async()=>{
 const detail=initial()
 detail.config={...detail.config,allowedTables:['sales.orders']}
 const requests:(string|undefined)[]=[]
 const {host}=await mount(async(path,_method,body)=>{
  if(!path.endsWith('/discover'))return path.includes('?')?{items:[detail.source],nextCursor:null}:detail
  const {directory}=(body as {directory?:string})
  requests.push(directory)
  if(directory==='finance'&&requests.filter(name=>name==='finance').length===1)throw Error('暂时不可用')
  return {items:directory?['payments']:['sales','finance'],truncated:false}
 },undefined,'page')
 await click('可见范围')
 await click('读取目录和表')
 await click('浏览 finance 的表')
 await click('重试读取表')
 expect(requests).toEqual([undefined,'finance','finance'])
 expect(host.textContent).toContain('finance 的表')
 expect(host.querySelector('[aria-label="已选表"]')?.textContent).toContain('sales.orders')
})

test('the current directory shows its picked count independently of search',async()=>{
 const detail=initial()
 detail.config={...detail.config,allowedTables:['public.orders','archive.orders']}
 const {host}=await mount(async(path,_method,body)=>path.endsWith('/discover')
  ? {items:(body as {directory?:string}).directory?['orders','items']:['public'],truncated:false}
  : path.includes('?')?{items:[detail.source],nextCursor:null}:detail,undefined,'page')
 await click('可见范围')
 await click('读取目录和表')
 await change('搜索表','items')
 expect(host.querySelector('[aria-label="目录 public 的表"] summary')?.textContent).toBe('public 的表（已选 1）')
})

test('a browsed directory can become the only allowed directory without changing table picks',async()=>{
 const detail=initial()
 detail.config={...detail.config,allowedTables:['public.orders','archive.orders']}
 const {host}=await mount(async(path,_method,body)=>path.endsWith('/discover')
  ? {items:(body as {directory?:string}).directory?['orders']:['public'],truncated:false}
  : path.includes('?')?{items:[detail.source],nextCursor:null}:detail,undefined,'page')
 await click('可见范围')
 await click('读取目录和表')
 await click('仅允许此目录')
 expect(input('目录范围').value).toBe('selected')
 expect(input('允许目录 public').checked).toBe(true)
 expect(host.querySelector('[aria-label="已选表"]')?.textContent).toContain('archive.orders')
})

test('manual scope rejects an oversized list locally but accepts pasted duplicate entries once',async()=>{
 const detail=initial()
 detail.config={...detail.config,allowedTables:[]}
 const writes:SaveSourceRequest[]=[]
 const {host}=await mount(async(path,method,body)=>{
  if(method==='PUT'){writes.push(body as SaveSourceRequest);return detail.source}
  return path.includes('?')?{items:[detail.source],nextCursor:null}:detail
 },undefined,'page')
 await click('可见范围')
 await change('允许访问的表',Array.from({length:257},(_,index)=>'public.table_'+index).join('\n'))
 await click('保存连接')
 expect(writes).toHaveLength(0)
 expect(host.textContent).toContain('填写了 257 张表，最多可选 256 张表')
 await change('允许访问的表',Array(257).fill('public.orders').join('\n'))
 await click('保存连接')
 expect(writes[0]?.config).toMatchObject({allowedTables:['public.orders']})
})

test('TLS connection advice points to the saved target option',async()=>{
 const {host}=await mount(async path=>path.endsWith('/test')?{ok:false,kind:'postgres',code:'SOURCE_TLS_UNSUPPORTED'}:read(path),undefined,'page')
 await click('测试连接')
 expect(host.textContent).toContain('请在全局配置中核对该目标是否启用了「使用 TLS」')
})

test('selecting specific tables automatically loads the table picker',async()=>{
 const detail=initial()
 const requests:(string|undefined)[]=[]
 await mount(async(path,_method,body)=>{
  if(!path.endsWith('/discover'))return path.includes('?')?{items:[detail.source],nextCursor:null}:detail
  const directory=(body as {directory?:string}).directory
  requests.push(directory)
  return {items:directory?['orders']:['public'],truncated:false}
 },undefined,'page')
 await click('可见范围')
 await change('表可见范围','selected')
 expect(requests).toEqual([undefined,'public'])
 expect(input('允许表 public.orders').checked).toBe(false)
 await act(async()=>input('允许表 public.orders').click())
 expect(input('允许表 public.orders').checked).toBe(true)
})

test('advanced connection settings follow the UI language through the sources dictionary',async()=>{
 const {LocaleProvider}=await import('../../../shell/src/renderer/src/locale')
 const {sourcesStrings}=await import('../../src/shell/i18n/strings-sources')
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);roots.push(root)
 const client=createSourcesClient((async (path:string)=>read(path)) as Request)
 await act(async()=>root.render(h(LocaleProvider,{initial:'en'},h(SourcesPanel,{client,onClose(){}}))))
 const row=[...host.querySelectorAll('button')].find(button=>button.textContent?.includes('营业收入'))!
 await act(async()=>row.click())
 for(const key of ['srcTimezone','srcMaxRowsAria','srcTimeoutAria','srcConnectionName','srcCredentialActions','srcSchemaScope','srcTableVisibility'] as const)expect(host.querySelector(`[aria-label="${sourcesStrings.en[key]}"]`),key).not.toBeNull()
 expect(host.textContent).toContain(sourcesStrings.en.srcTimeout)
 expect(host.textContent).toContain(sourcesStrings.en.srcSaveConnection)
 // Apart from fixture data (the connection name and a unit in the public JSON), no Chinese UI text remains.
 const visible=(host.textContent??'').replaceAll('营业收入','').replaceAll('元','')
 expect(visible.match(/[\u4e00-\u9fff]+/g)).toBeNull()
 const labels=[...host.querySelectorAll('[aria-label],[placeholder],[title]')].flatMap(node=>['aria-label','placeholder','title'].map(name=>node.getAttribute(name)??'')).join(' ').replaceAll('营业收入','')
 expect(labels.match(/[\u4e00-\u9fff]+/g)).toBeNull()
})

test('confirmed connection save recovers with a read while stale writes are disabled', async()=>{
 let writes=0, failDetails=false, saved=initial()
 await mount(async(path,method='GET',body)=>{
  if(method==='PUT'){
   writes++
   saved={...saved,source:{...saved.source,name:(body as SaveSourceRequest).name!,version:saved.source.version+1}}
   failDetails=true
   return saved.source
  }
  if(path.includes('?'))return {items:[saved.source],nextCursor:null}
  if(failDetails)throw Object.assign(Error('read failed'),{status:503})
  return saved
 },undefined,'page')
 await change('连接名称','已经保存')
 await click('保存连接')
 expect(document.querySelector('[role="alert"]')?.textContent).toContain('连接已保存')
 expect(button('保存连接').disabled).toBe(true)
 failDetails=false
 await click('读取最新配置并核对')
 expect(input('连接名称').value).toBe('已经保存')
 expect(button('测试连接').disabled).toBe(false)
 expect(writes).toBe(1)
})

test('clearing the query row limit lets the server restore its default',async()=>{
 let saved:SaveSourceRequest|undefined
 await mount(async(path,method='GET',body)=>{
  if(method==='PUT'){saved=body as SaveSourceRequest;return initial().source}
  return read(path)
 })
 await change('查询最大行数','')
 expect(input('查询最大行数').value).toBe('')
 await click('保存连接')
 expect(saved?.config).not.toHaveProperty('maxRows')
})

test('a typed connection address can be checked once and is masked when changing tabs',async()=>{
 await mount(async path=>read(path),undefined,'page')
 await change('凭据操作','replace')
 await change('连接凭据','postgresql://reader:test-only@db.example/reporting')
 expect(input('连接凭据').type).toBe('password')
 await click('显示连接地址')
 expect(input('连接凭据').type).toBe('text')
 await click('可见范围');await click('连接设置')
 expect(input('连接凭据').type).toBe('password')
 expect(input('连接凭据').value).toContain('db.example/reporting')
})
