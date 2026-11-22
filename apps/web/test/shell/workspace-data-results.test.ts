import { afterEach, expect, test, vi } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { WorkspaceDataResults } from '../../src/shell/WorkspaceDataResults'
import { createSourceResultsClient } from '../../src/shell/source-results-client'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const roots: Root[] = []
const resultId = '11111111-1111-4111-8111-111111111111'
const artifact = { resultId, workspaceId: '22222222-2222-4222-8222-222222222222', sourceId: 'sales', sourceVersion: 2, queryHash: 'b'.repeat(64), sha256: 'a'.repeat(64), rowCount: 1001, truncated: true, sizeBytes: 10000, state: 'saved', name: '收入快照', createdAt: '2026-11-17T00:00:00Z', savedAt: '2026-11-17T00:00:00Z', expiresAt: null }
afterEach(async () => { await act(async () => { for (const root of roots.splice(0)) root.unmount() }); document.body.innerHTML = '' })

test('workspace result list reads frozen pages and downloads authorized JSON without querying the source', async () => {
 const calls: {path: string; body?: unknown}[] = []
 const request = async (path: string, _method?: string, body?: unknown): Promise<unknown> => {
  calls.push({path,body})
  if (path.endsWith('/content')) return {literal:'=safe',amount:42}
  if (path.endsWith('/data-results')) return {items:[artifact],nextCursor:null}
  const offset=(body as {arguments:{offset:number}}).arguments.offset
  return {artifact,schema:[{name:'amount',type:'number',unit:'元'}],rows:[{amount:offset?43:42}],timezone:'Asia/Shanghai',offset,nextOffset:offset?null:1000,totalRows:1001,sourceTruncated:true,sha256:artifact.sha256}
 }
 const client=createSourceResultsClient(request as Parameters<typeof createSourceResultsClient>[0])
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);roots.push(root)
 await act(async()=>root.render(h(WorkspaceDataResults,{client,onClose(){}})))
 const choose=[...host.querySelectorAll('button')].find(button=>button.textContent==='收入快照')!
 await act(async()=>choose.click())
 expect(host.textContent).toContain('原查询已截断')
 expect(host.textContent).toContain('amount（元）')
 expect(host.textContent).toContain('Asia/Shanghai')
 const next=[...host.querySelectorAll('button')].find(button=>button.textContent==='下一批')!
 await act(async()=>next.click())
 expect((calls.at(-1)?.body as {arguments:{offset:number}}).arguments.offset).toBe(1000)
 const createUrl=vi.spyOn(URL,'createObjectURL').mockReturnValue('blob:authorized')
 const revoke=vi.spyOn(URL,'revokeObjectURL').mockImplementation(()=>{})
 const click=vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(()=>{})
 const download=[...host.querySelectorAll('button')].find(button=>button.textContent==='下载 JSON')!
 await act(async()=>download.click())
 expect(calls.at(-1)?.path).toBe(`/api/v1/workspace/data-results/${resultId}/content`)
 expect(createUrl).toHaveBeenCalledOnce();expect(click).toHaveBeenCalledOnce()
 await new Promise(resolve=>setTimeout(resolve,10));expect(revoke).toHaveBeenCalledWith('blob:authorized')
 vi.restoreAllMocks()
 expect(calls.some(call=>call.path.includes('/sources/'))).toBe(false)
 expect(calls.filter(call=>call.body).every(call=>(call.body as {name:string}).name==='sources.read_result')).toBe(true)
})

test('new session key clears old preview and late download cannot start after unmount', async () => {
 let resolveDownload!: (value: string) => void
 const download = new Promise<string>(resolve => { resolveDownload=resolve })
 const oldClient=createSourceResultsClient(async () => ({items:[artifact],nextCursor:null}) as never)
 oldClient.download=()=>download
 const nextClient=createSourceResultsClient(async () => ({items:[],nextCursor:null}) as never)
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);roots.push(root)
 const createUrl=vi.spyOn(URL,'createObjectURL').mockReturnValue('blob:must-not-open')
 await act(async()=>root.render(h(WorkspaceDataResults,{key:'alice',client:oldClient,onClose(){}})))
 const button=[...host.querySelectorAll('button')].find(button=>button.textContent==='下载 JSON')!
 await act(async()=>button.click())
 await act(async()=>root.render(h(WorkspaceDataResults,{key:'bob',client:nextClient,onClose(){}})))
 await act(async()=>resolveDownload('{"private":"Alice"}'))
 expect(host.textContent).not.toContain('收入快照');expect(createUrl).not.toHaveBeenCalled()
 vi.restoreAllMocks()
})

test('deleting a saved result asks first, calls DELETE once and frees the row; cancelling changes nothing', async () => {
 const calls: {path: string; method?: string}[] = []
 const request = async (path: string, method?: string): Promise<unknown> => {
  calls.push({path,method})
  if (method === 'DELETE') return undefined
  return {items:[artifact],nextCursor:null}
 }
 const client=createSourceResultsClient(request as Parameters<typeof createSourceResultsClient>[0])
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);roots.push(root)
 await act(async()=>root.render(h(WorkspaceDataResults,{client,onClose(){}})))
 const remove=()=>host.querySelector<HTMLButtonElement>(`[aria-label="删除结果 ${artifact.name}"]`)
 const confirm=vi.spyOn(window,'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true)
 await act(async()=>remove()!.click())
 expect(calls.some(call=>call.method==='DELETE')).toBe(false)
 expect(remove()).not.toBeNull()
 await act(async()=>remove()!.click())
 expect(confirm).toHaveBeenCalledTimes(2)
 expect(calls.filter(call=>call.method==='DELETE')).toEqual([{path:`/api/v1/workspace/data-results/${resultId}`,method:'DELETE'}])
 expect(remove()).toBeNull()
 expect(host.querySelector('[role=status]')?.textContent).toContain('已删除')
})
