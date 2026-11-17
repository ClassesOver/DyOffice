import { afterEach, expect, test } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SourcesPanel } from '../../src/shell/SourcesPanel'
import { createSourcesClient } from '../../src/shell/sources-client'
import { createSourceResultsClient } from '../../src/shell/source-results-client'
import type { SourceDetail, SaveSourceRequest } from '../../../../packages/web-contracts/src/sources'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const roots: Root[] = []
const initial = (): SourceDetail => ({ source: { sourceId: 'revenue', name: '营业收入', kind: 'postgres', version: 3, enabled: true, publishedRevision: 1, hasCredential: true, hasUnpublishedChanges: false, updatedAt: '2026-11-17T00:00:00Z' }, config: { timezone: 'UTC', maxRows: 10, units: { amount: '元' } }, published: { sourceId: 'revenue', revision: 1, contentHash: 'a'.repeat(64), publishedAt: '2026-11-17T00:00:00Z', name: '营业收入', kind: 'postgres', config: {}, execution: { maxRows: 10 } } })
type Request = Parameters<typeof createSourcesClient>[0]
async function mount(run: (path: string, method?: string, body?: unknown) => Promise<unknown>, onCloseGuardChange?: (guard:(()=>boolean)|null)=>void) {
 const client = createSourcesClient(run as Request), host = document.createElement('div'); document.body.append(host)
 const root = createRoot(host); roots.push(root)
 await act(async () => root.render(h(SourcesPanel, { client, onClose() {}, onCloseGuardChange })))
 const row = [...host.querySelectorAll('button')].find(button => button.textContent?.includes('营业收入'))!
 await act(async () => row.click())
 return { client, host }
}
function button(label: string) { const result = [...document.querySelectorAll('button')].find(button => button.textContent === label); expect(result, label).toBeDefined(); return result! }
async function click(label: string) { await act(async () => button(label).click()) }
function input(label: string) { const node = document.querySelector<HTMLInputElement>(`[aria-label="${label}"]`); expect(node).not.toBeNull(); return node! }
async function change(label: string, value: string) {
 if(label==='凭据操作'||label==='连接器'){
  const labels:Record<string,string>={replace:'替换凭据',clear:'清空草稿凭据',retain:'保留现有凭据',http:'HTTP JSON',postgres:'PostgreSQL',mysql:'MySQL',starrocks:'StarRocks'}
  await act(async()=>document.querySelector(`[aria-label="${label}"]`)!.dispatchEvent(new MouseEvent('mousedown',{bubbles:true})))
  await act(async()=>{const option=[...document.querySelectorAll<HTMLElement>('.ant-select-item-option')].find(node=>node.textContent?.includes(labels[value]))!;expect(option).toBeDefined();option.click()})
  return
 }
 await act(async () => { const node = document.querySelector<HTMLInputElement | HTMLSelectElement>(`[aria-label="${label}"]`)!; const select = node instanceof HTMLSelectElement
 Object.getOwnPropertyDescriptor(select ? HTMLSelectElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(node, value)
 node.dispatchEvent(new Event(select ? 'change' : 'input', { bubbles: true })) })
}
afterEach(async () => { await act(async () => { for (const root of roots.splice(0)) root.unmount() }); document.body.innerHTML = '' })
function read(path: string) { return path.includes('?') ? { items: [initial().source], nextCursor: null } : initial() }

test.each(['READONLY_ROLE_REQUIRED', 'SOURCE_TIMEOUT', 'SOURCE_UNAVAILABLE'])('failed connection test %s is presented as an error and a later success clears it', async code => {
 let ok = false
 const {host} = await mount(async (path, method = 'GET') => method === 'POST' ? {ok, code, kind: 'postgres'} : read(path))
 await click('测试已保存草稿')
 expect(host.querySelector('.ant-alert-success')).toBeNull()
 expect(host.querySelector('.ant-alert-error')?.textContent).toMatch(/未通过|超时/)
 ok = true
 await click('测试已保存草稿')
 expect(host.querySelector('.ant-alert-error')).toBeNull()
 expect(host.querySelector('.ant-alert-success')?.textContent).toContain('连接测试通过')
})

test('source management never reads back a DSN and an unchanged secret is omitted from save', async () => {
 let body: SaveSourceRequest | undefined
 await mount(async (path, method = 'GET', value) => { if (method === 'PUT') { body = value as SaveSourceRequest; return initial().source } return read(path) })
 expect(document.querySelector('[aria-label="连接凭据"]')).toBeNull()
 await change('连接名称', '新的名称'); await click('保存草稿')
 expect(body?.expectedVersion).toBe(3)
 expect(body?.name).toBe('新的名称')
 expect(body).not.toHaveProperty('secret')
})

test.each([409, 503])('HTTP %i preserves edited fields, clears entered credentials and never displays raw errors', async status => {
 await mount(async (path, method = 'GET') => { if (method === 'PUT') throw Object.assign(Error('postgres://private:secret@host/db'), { status }); return read(path) })
 await change('连接名称', '保留的草稿'); await change('凭据操作', 'replace'); await change('连接凭据', 'postgres://one-use')
 await click('保存草稿')
 expect(input('连接名称').value).toBe('保留的草稿')
 expect(input('连接凭据').value).toBe('')
 expect(document.body.textContent).not.toContain('private:secret')
 expect(document.querySelector('[role="alert"]')).not.toBeNull()
})

test('reading after unknown write does not unblock mutation until the server version is explicitly adopted', async () => {
 let writes = 0
 const { client } = await mount(async (path, method = 'GET') => { if (method === 'PUT') { writes++; throw Error('network') } return read(path) })
 await change('连接名称', '草稿'); await click('保存草稿')
 expect(client.getState().unknownWrite).toBe(true)
 await click('读取最新版本并核对')
 expect(client.getState().unknownWrite).toBe(true)
 expect(input('连接名称').value).toBe('草稿')
 await click('采用服务器版本并放弃当前草稿')
 expect(client.getState().unknownWrite).toBe(false)
 expect(input('连接名称').value).toBe('营业收入')
 expect(writes).toBe(1)
})

test('credential clearing is explicit null, independent of an omitted credential', async () => {
 let sent: SaveSourceRequest | undefined
 await mount(async (path, method = 'GET', body) => { if (method === 'PUT') { sent = body as SaveSourceRequest; return initial().source } return read(path) })
 await change('凭据操作', 'clear'); await click('保存草稿')
 expect(sent?.secret).toBeNull()
})

test('query result shows frozen provenance units timezone and truncation without executing draft configuration', async () => {
 let query: unknown
 await mount(async (path, method = 'GET', body) => {
   if (path.endsWith('/query')) { query = body; return { version: 1, sourceId: 'revenue', sourceVersion: 1, timezone: 'Asia/Shanghai', schema: [{ name: 'amount', type: 'number', unit: '元' }], rows: [{ amount: 42 }], truncated: true, sha256: 'b'.repeat(64) } }
   return read(path)
 })
 await click('执行已发布查询')
 expect(query).toEqual({ sql: 'SELECT 1 AS value' })
 expect(document.body.textContent).toContain('Asia/Shanghai')
 expect(document.body.textContent).toContain('amount（元）')
 expect(document.body.textContent).toContain('结果已截断')
 expect(document.body.textContent).toContain('b'.repeat(64))
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
 await click('读取最新版本并核对')
 expect(document.body.textContent).toContain('服务器确认此连接已不存在')
 expect(client.getState().unknownWrite).toBe(true)
 await click('确认不存在并开始新建')
 expect(client.getState().unknownWrite).toBe(false)
 expect(deletes).toBe(1)
})


test('saving a frozen result retries the same receipt intent without rerunning its source query', async()=>{
 const calls: {name:string;arguments:Record<string,unknown>}[]=[]
 const artifact={resultId:'11111111-1111-4111-8111-111111111111',sourceId:'revenue',sourceVersion:1,rowCount:1,truncated:true,sha256:'b'.repeat(64),state:'pending'}
 const resultRequest=async(_path:string,_method?:string,raw?:unknown)=>{
   const call=raw as {name:string;arguments:Record<string,unknown>};calls.push(structuredClone(call))
   if(call.name==='sources.query')return {artifact,schema:[{name:'amount',type:'number',unit:'元'}],timezone:'UTC',preview:[{amount:42}],totalRows:1,sourceTruncated:true,sha256:artifact.sha256,nextOffset:null,notice:'bounded'}
   if(calls.filter(c=>c.name==='sources.save_result').length===1)throw Error('lost response')
   return {...artifact,state:'saved',name:'冻结收入'}
 }
 const client=createSourcesClient((async(path:string)=>read(path)) as Request)
 const resultsClient=createSourceResultsClient(resultRequest as Parameters<typeof createSourceResultsClient>[0])
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);roots.push(root)
 await act(async()=>root.render(h(SourcesPanel,{client,resultsClient,onClose(){}})))
 await act(async()=>[...host.querySelectorAll('button')].find(b=>b.textContent?.includes('营业收入'))!.click())
 await click('执行已发布查询');await change('工作区结果名称','冻结收入');await click('保存结果到工作区')
 expect(host.textContent).toContain('保存结果未确认')
 await click('确认保存结果')
 const saves=calls.filter(c=>c.name==='sources.save_result')
 expect(saves).toHaveLength(2);expect(saves[0].arguments).toEqual(saves[1].arguments)
 expect(calls.filter(c=>c.name==='sources.query')).toHaveLength(1)
 expect(host.textContent).toContain('已保存到工作区')
 expect(host.textContent).toContain('原查询已截断')
})


test('overprivileged source account is identified without echoing a target grant or secret', async()=>{
 await mount(async(path,method='GET')=>path.endsWith('/test')?{ok:false,kind:'starrocks',code:'READONLY_ROLE_REQUIRED'}:read(path))
 await click('测试已保存草稿')
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
 expect((host.querySelector('[aria-label="连接凭据"]') as HTMLInputElement).value).toBe('')
})

test('friendly timezone and row-limit fields save public configuration while preserving advanced units',async()=>{
 let saved:SaveSourceRequest|undefined
 await mount(async(path,method='GET',body)=>{if(method==='PUT'){saved=body as SaveSourceRequest;return initial().source}return read(path)})
 expect(document.querySelector('[aria-label="时区"]')).not.toBeNull()
 await change('时区','Asia/Shanghai')
 await change('查询最大行数','250')
 await click('保存草稿')
 expect(saved?.config).toEqual({timezone:'Asia/Shanghai',maxRows:250,units:{amount:'元'}})
 expect(document.querySelector('details summary')?.textContent).toContain('高级配置')
})

test('restoring original source values releases the dirty close guard',async()=>{
 let guard:(()=>boolean)|null=null
 await mount(async path=>read(path),value=>{guard=value})
 expect(guard).toBeNull()
 await change('连接名称','临时名称');expect(guard).toBeTypeOf('function')
 await change('连接名称','营业收入');expect(guard).toBeNull()
 expect(document.body.textContent).not.toContain('当前有未保存草稿')
})

test('new data connections default to PostgreSQL and offer only supported database connectors',async()=>{
 let created:unknown
 const client=createSourcesClient((async(path:string,method='GET',body?:unknown)=>{if(method==='POST'){created=body;return initial().source}return path.includes('?')?{items:[],nextCursor:null}:initial()}) as Request)
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);roots.push(root)
 await act(async()=>root.render(h(SourcesPanel,{client,onClose(){}})))
 expect(host.textContent).toContain('数据连接')
 expect(document.querySelector('[aria-label="连接器"]')?.closest('.ant-select')?.textContent).toContain('PostgreSQL')
 await act(async()=>document.querySelector('[aria-label="连接器"]')!.dispatchEvent(new MouseEvent('mousedown',{bubbles:true})))
 expect([...document.querySelectorAll('.ant-select-item-option')].map(node=>node.textContent)).toEqual(['PostgreSQL','MySQL','StarRocks'])
 await change('连接标识','qa_database');await change('连接名称','QA数据库');await change('连接凭据','postgres://qa:qa@db.example/qa')
 await click('保存草稿')
 expect(created).toMatchObject({kind:'postgres',sourceId:'qa_database',secret:'postgres://qa:qa@db.example/qa'})
})

test('legacy HTTP connections remain visible and queryable but cannot be edited published or deleted',async()=>{
 let mutations=0,query:unknown
 const legacy:SourceDetail={...initial(),source:{...initial().source,kind:'http'},published:{...initial().published!,kind:'http'}}
 await mount(async(path,method='GET',body)=>{
  if(path.endsWith('/query')){query=body;return {version:1,sourceId:'revenue',sourceVersion:1,timezone:'UTC',schema:[],rows:[],truncated:false,sha256:'b'.repeat(64)}}
  if(method!=='GET')mutations++
  return path.includes('?')?{items:[legacy.source],nextCursor:null}:legacy
 })
 expect(document.body.textContent).toContain('HTTP 连接仅支持只读查看')
 expect(input('连接名称').disabled).toBe(true)
 expect(button('保存草稿').disabled).toBe(true)
 expect(button('发布草稿').disabled).toBe(true)
 expect(button('删除连接').disabled).toBe(true)
 expect(document.querySelector('[aria-label="连接凭据"]')).toBeNull()
 await click('执行已发布查询')
 expect(query).toEqual({})
 expect(mutations).toBe(0)
})

test('refreshing a source list preserves credentials that have not been submitted',async()=>{
 await mount(async path=>read(path))
 await change('凭据操作','replace');await change('连接凭据','UNSUBMITTED-MOCK')
 await click('刷新列表')
 expect(input('连接凭据').value).toBe('UNSUBMITTED-MOCK')
})
test('an unconfirmed frozen-result save cannot be bypassed by a new query or another source selection',async()=>{
 let queries=0;const saves:unknown[]=[]
 const artifact={resultId:'11111111-1111-4111-8111-111111111111',sourceId:'revenue',sourceVersion:1,rowCount:1,truncated:false,sha256:'b'.repeat(64),state:'pending'}
 const resultsClient=createSourceResultsClient((async(_path:string,_method?:string,body:unknown)=>{const call=body as {name:string;arguments:unknown};if(call.name==='sources.query'){queries++;return {artifact,schema:[{name:'amount',type:'number'}],timezone:'UTC',preview:[{amount:42}],totalRows:1,sourceTruncated:false,sha256:artifact.sha256,nextOffset:null}}saves.push(call.arguments);throw Error('lost response')}) as Parameters<typeof createSourceResultsClient>[0])
 const client=createSourcesClient((async(path:string)=>read(path)) as Request)
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);roots.push(root)
 await act(async()=>root.render(h(SourcesPanel,{client,resultsClient,onClose(){}})))
 const source=[...host.querySelectorAll('button')].find(b=>b.textContent?.includes('营业收入'))!
 await act(async()=>source.click());await click('执行已发布查询');await click('保存结果到工作区')
 expect(button('执行已发布查询').disabled).toBe(true)
 expect(source.disabled).toBe(true)
 expect(button('保存草稿').disabled).toBe(true)
 await click('确认保存结果')
 expect(queries).toBe(1);expect(saves).toHaveLength(2);expect(saves[0]).toEqual(saves[1])
})
test('dirty source drafts block browser unload without opening a second confirmation',async()=>{
 await mount(async path=>read(path));await change('连接名称','未保存')
 const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event)
 expect(event.defaultPrevented).toBe(true)
 await change('连接名称','营业收入')
 const clean=new Event('beforeunload',{cancelable:true});window.dispatchEvent(clean)
 expect(clean.defaultPrevented).toBe(false)
})

test.each([400,403,404,413,422])('a known frozen-result save rejection HTTP %i releases the intent so the user can correct or rerun',async status=>{
 const artifact={resultId:'11111111-1111-4111-8111-111111111111',sourceId:'revenue',sourceVersion:1,rowCount:1,truncated:false,sha256:'b'.repeat(64),state:'pending'}
 const resultsClient=createSourceResultsClient((async(_path:string,_method?:string,body:unknown)=>{const call=body as {name:string};if(call.name==='sources.query')return {artifact,schema:[],timezone:'UTC',preview:[],totalRows:0,sourceTruncated:false,sha256:artifact.sha256,nextOffset:null};throw Object.assign(Error('private backend detail'),{status})}) as Parameters<typeof createSourceResultsClient>[0])
 const client=createSourcesClient((async(path:string)=>read(path)) as Request),host=document.createElement('div');document.body.append(host);const root=createRoot(host);roots.push(root)
 await act(async()=>root.render(h(SourcesPanel,{client,resultsClient,onClose(){}})))
 await act(async()=>[...host.querySelectorAll('button')].find(b=>b.textContent?.includes('营业收入'))!.click())
 await click('执行已发布查询');await click('保存结果到工作区')
 expect(input('工作区结果名称').disabled).toBe(false)
 expect(button('执行已发布查询').disabled).toBe(false)
 expect(host.textContent).not.toContain('保存结果未确认')
 expect(host.textContent).not.toContain('private backend detail')
})

test('a failed new query labels the retained previous result so it cannot be mistaken for the latest SQL',async()=>{
 let fail=false
 await mount(async(path)=>{if(path.endsWith('/query')){if(fail)throw Object.assign(Error('bad query'),{status:400});return {version:1,sourceId:'revenue',sourceVersion:1,timezone:'UTC',schema:[{name:'amount',type:'number'}],rows:[{amount:42}],truncated:false,sha256:'b'.repeat(64)}}return read(path)})
 await click('执行已发布查询');fail=true;await click('执行已发布查询')
 expect(document.querySelector('[aria-label="查询结果"]')?.textContent).toContain('上一次成功查询的结果')
 expect(document.querySelector('[aria-label="查询结果"]')?.textContent).toContain('42')
})

test.each(['stale_session','previous_unknown'])('a %s result preserves the original frozen-save command even if a later error has HTTP 403',async mode=>{
 const calls:unknown[]=[]
 const artifact={resultId:'11111111-1111-4111-8111-111111111111',sourceId:'revenue',sourceVersion:1,rowCount:1,truncated:false,sha256:'b'.repeat(64),state:'pending'}
 const resultsClient=createSourceResultsClient((async(_path:string,_method?:string,body:unknown)=>{const call=body as {name:string;arguments:unknown};if(call.name==='sources.query')return {artifact,schema:[],timezone:'UTC',preview:[],totalRows:0,sourceTruncated:false,sha256:artifact.sha256,nextOffset:null};calls.push(call.arguments);if(mode==='previous_unknown'&&calls.length===1)throw Error('lost response');throw Object.assign(Error('unconfirmed'),{status:403,...(mode==='stale_session'?{code:'stale_session'}:{})})}) as Parameters<typeof createSourceResultsClient>[0])
 const client=createSourcesClient((async(path:string)=>read(path)) as Request),host=document.createElement('div');document.body.append(host);const root=createRoot(host);roots.push(root)
 await act(async()=>root.render(h(SourcesPanel,{client,resultsClient,onClose(){}})))
 await act(async()=>[...host.querySelectorAll('button')].find(b=>b.textContent?.includes('营业收入'))!.click())
 await click('执行已发布查询');await click('保存结果到工作区')
 if(mode==='previous_unknown')await click('确认保存结果')
 expect(input('工作区结果名称').disabled).toBe(true)
 expect(button('执行已发布查询').disabled).toBe(true)
 expect(host.textContent).toContain('保存结果未确认')
 await click('确认保存结果')
 expect(calls.at(-1)).toEqual(calls[0])
})

test('an unknown publish on A survives browsing and adopting B until A is read and adopted',async()=>{
 const a=initial(),b={...initial(),source:{...initial().source,sourceId:'other',name:'另一连接'}}
 let publishes=0
 const {client}=await mount(async(path,method='GET')=>{if(method==='POST'&&path.endsWith('/publish')){publishes++;throw Error('lost response')}if(path.includes('?'))return {items:[a.source,b.source],nextCursor:null};return path.endsWith('/other')?b:a})
 await click('发布草稿');expect(client.getState().unknownWrite).toBe(true)
 await act(async()=>{[...document.querySelectorAll<HTMLButtonElement>('.source-item')].find(node=>node.textContent?.includes('另一连接'))!.click()})
 expect(input('连接名称').value).toBe('另一连接')
 await click('读取最新版本并核对');await click('采用服务器版本并放弃当前草稿')
 expect(client.getState().unknownWrite).toBe(true)
 expect(button('发布草稿').disabled).toBe(true)
 await act(async()=>{[...document.querySelectorAll<HTMLButtonElement>('.source-item')].find(node=>node.textContent?.includes('营业收入'))!.click()})
 await click('读取最新版本并核对');await click('采用服务器版本并放弃当前草稿')
 expect(client.getState().unknownWrite).toBe(false);expect(button('发布草稿').disabled).toBe(false);expect(publishes).toBe(1)
})

test('the affected identity remains directly reconcilable after browsing B and refreshing away deleted A',async()=>{
 const a=initial(),b={...initial(),source:{...initial().source,sourceId:'other',name:'另一连接'}};let deleted=false
 const {client}=await mount(async(path,method='GET')=>{if(method==='DELETE'){deleted=true;throw Error('lost')}if(path.includes('?'))return {items:deleted?[b.source]:[a.source,b.source],nextCursor:null};if(deleted&&path.endsWith('/revenue'))throw Object.assign(Error('missing'),{status:404});return path.endsWith('/other')?b:a})
 await act(async()=>document.querySelector<HTMLInputElement>('[aria-label="确认删除此连接"]')!.click());await click('删除连接')
 await act(async()=>{[...document.querySelectorAll<HTMLButtonElement>('.source-item')].find(node=>node.textContent?.includes('另一连接'))!.click()});await click('刷新列表')
 expect(document.querySelectorAll('.source-item').length).toBe(1)
 await click('读取待核对连接（revenue）');await click('确认不存在并开始新建')
 expect(client.getState().unknownWrite).toBe(false)
})

test.each(['dialog','page'] as const)('a failed initial source list is announced before the %s controls and can be refreshed',async presentation=>{
 let failed=true,writes=0
 const client=createSourcesClient((async(_path:string,method='GET')=>{if(method!=='GET')writes++;if(failed)throw Object.assign(Error('private backend failure'),{status:503});return {items:[initial().source],nextCursor:null}}) as Request)
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);roots.push(root)
 await act(async()=>root.render(h(SourcesPanel,{client,presentation,onClose(){}})))
 const error=host.querySelector('.ant-alert-error')!
 expect(error.textContent).toContain('暂不可用')
 expect(error.textContent).not.toContain('private backend failure')
 expect(error.compareDocumentPosition(host.querySelector('.source-list')!)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
 expect(error.compareDocumentPosition(host.querySelector('.source-fields')!)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
 failed=false;await click('刷新列表')
 expect(host.querySelector('.ant-alert-error')).toBeNull()
 expect(host.querySelector('.source-item')?.textContent).toContain('营业收入')
 expect(writes).toBe(0)
})
