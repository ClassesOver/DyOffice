import { afterEach, expect, test } from 'vitest'
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
 expect((host.querySelector('a') as HTMLAnchorElement).getAttribute('href')).toBe(`/api/v1/workspace/data-results/${resultId}/content`)
 expect(calls.some(call=>call.path.includes('/sources/'))).toBe(false)
 expect(calls.filter(call=>call.body).every(call=>(call.body as {name:string}).name==='sources.read_result')).toBe(true)
})
