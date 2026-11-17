import { afterEach, expect, test } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SourcesPanel } from '../../src/shell/SourcesPanel'
import { createSourcesClient } from '../../src/shell/sources-client'
import type { SourceDetail, SaveSourceRequest } from '../../../../packages/web-contracts/src/sources'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const roots: Root[] = []
const initial = (): SourceDetail => ({ source: { sourceId: 'revenue', name: '营业收入', kind: 'postgres', version: 3, enabled: true, publishedRevision: 1, hasCredential: true, hasUnpublishedChanges: false, updatedAt: '2026-11-17T00:00:00Z' }, config: { timezone: 'UTC', maxRows: 10, units: { amount: '元' } }, published: { sourceId: 'revenue', revision: 1, contentHash: 'a'.repeat(64), publishedAt: '2026-11-17T00:00:00Z', name: '营业收入', kind: 'postgres', config: {}, execution: { maxRows: 10 } } })
type Request = Parameters<typeof createSourcesClient>[0]
async function mount(run: (path: string, method?: string, body?: unknown) => Promise<unknown>) {
 const client = createSourcesClient(run as Request), host = document.createElement('div'); document.body.append(host)
 const root = createRoot(host); roots.push(root)
 await act(async () => root.render(h(SourcesPanel, { client, onClose() {} })))
 const row = [...host.querySelectorAll('button')].find(button => button.textContent?.includes('营业收入'))!
 await act(async () => row.click())
 return { client, host }
}
function button(label: string) { const result = [...document.querySelectorAll('button')].find(button => button.textContent === label); expect(result, label).toBeDefined(); return result! }
async function click(label: string) { await act(async () => button(label).click()) }
function input(label: string) { const node = document.querySelector<HTMLInputElement>(`[aria-label="${label}"]`); expect(node).not.toBeNull(); return node! }
async function change(label: string, value: string) {
 await act(async () => { const node = document.querySelector<HTMLInputElement | HTMLSelectElement>(`[aria-label="${label}"]`)!; const select = node instanceof HTMLSelectElement
 Object.getOwnPropertyDescriptor(select ? HTMLSelectElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(node, value)
 node.dispatchEvent(new Event(select ? 'change' : 'input', { bubbles: true })) })
}
afterEach(async () => { await act(async () => { for (const root of roots.splice(0)) root.unmount() }); document.body.innerHTML = '' })
function read(path: string) { return path.includes('?') ? { items: [initial().source], nextCursor: null } : initial() }

test('source management never reads back a DSN and an unchanged secret is omitted from save', async () => {
 let body: SaveSourceRequest | undefined
 await mount(async (path, method = 'GET', value) => { if (method === 'PUT') { body = value as SaveSourceRequest; return initial().source } return read(path) })
 expect(document.querySelector('[aria-label="连接凭据"]')).toBeNull()
 await change('数据源名称', '新的名称'); await click('保存草稿')
 expect(body?.expectedVersion).toBe(3)
 expect(body?.name).toBe('新的名称')
 expect(body).not.toHaveProperty('secret')
})

test.each([409, 503])('HTTP %i preserves edited fields, clears entered credentials and never displays raw errors', async status => {
 await mount(async (path, method = 'GET') => { if (method === 'PUT') throw Object.assign(Error('postgres://private:secret@host/db'), { status }); return read(path) })
 await change('数据源名称', '保留的草稿'); await change('凭据操作', 'replace'); await change('连接凭据', 'postgres://one-use')
 await click('保存草稿')
 expect(input('数据源名称').value).toBe('保留的草稿')
 expect(input('连接凭据').value).toBe('')
 expect(document.body.textContent).not.toContain('private:secret')
 expect(document.querySelector('[role="alert"]')).not.toBeNull()
})

test('reading after unknown write does not unblock mutation until the server version is explicitly adopted', async () => {
 let writes = 0
 const { client } = await mount(async (path, method = 'GET') => { if (method === 'PUT') { writes++; throw Error('network') } return read(path) })
 await change('数据源名称', '草稿'); await click('保存草稿')
 expect(client.getState().unknownWrite).toBe(true)
 await click('读取最新版本并核对')
 expect(client.getState().unknownWrite).toBe(true)
 expect(input('数据源名称').value).toBe('草稿')
 await click('采用服务器版本并放弃当前草稿')
 expect(client.getState().unknownWrite).toBe(false)
 expect(input('数据源名称').value).toBe('营业收入')
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
