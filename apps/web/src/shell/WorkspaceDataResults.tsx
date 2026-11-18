import {Button, Alert, Table} from 'antd'
import { useEffect, useRef, useState } from 'react'
import {offerSourceResultDownload} from './source-result-download'
import type { SourceResultsClient } from './source-results-client'
import type { WorkspaceSourceResultArtifact, WorkspaceSourceResultPage } from '../../../../packages/web-contracts/src/source-results.ts'

export function WorkspaceDataResults({ client, onClose, presentation = 'dialog' }: { client: SourceResultsClient; onClose: () => void; presentation?: 'dialog' | 'page'; onCloseGuardChange?: (guard: (() => boolean) | null) => void }) {
  const [items, setItems] = useState<WorkspaceSourceResultArtifact[]>([]), [cursor, setCursor] = useState<string | null>(null)
  const [page, setPage] = useState<WorkspaceSourceResultPage | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    let live = true
    void client.list().then(result => { if (live) { setItems(result.items); setCursor(result.nextCursor) } }).catch(() => { if (live) setError('无法读取当前工作区的数据结果。') })
    return () => { live = false; alive.current = false }
  }, [client])
  async function run(action: () => Promise<void>) {
    if (busy) return
    setBusy(true); setError('')
    try { await action() } catch { if (alive.current) setError('无法读取当前工作区的数据结果，请检查会话后重试。') }
    finally { if (alive.current) setBusy(false) }
  }
  async function read(resultId: string, offset = 0) { const value = await client.read(resultId, offset); if (alive.current) setPage(value) }
  return <div className={presentation === 'page' ? 'workspace-panel-host' : 'set-overlay'}><section className={presentation === 'page' ? 'workspace-panel workspace-data-results-panel' : 'set-dialog source-dialog'} role={presentation === 'page' ? undefined : 'dialog'} aria-modal={presentation === 'page' ? undefined : true} aria-label="工作区数据结果">
    <div className={presentation === 'page' ? 'workspace-panel-header' : 'set-header'}><h2 className="set-title">工作区数据结果</h2><Button autoInsertSpace={false} disabled={presentation === 'dialog' && busy} onClick={onClose}>关闭</Button></div>
    <div className={presentation === 'page' ? 'workspace-panel-body' : 'set-body'}><p>这里保存的是已冻结的查询结果，不会在打开、翻页或下载时重新查询数据库。截断结果会继续显示截断标记。</p>
      <ul>{items.map(item => <li key={item.resultId}><Button autoInsertSpace={false} disabled={busy} onClick={() => void run(() => read(item.resultId))}>{item.name}</Button>
        <span> {item.sourceId} r{item.sourceVersion} · {item.rowCount} 行{item.truncated ? ' · 源查询已截断' : ''}</span>
        <Button autoInsertSpace={false} disabled={busy} onClick={() => void run(async () => { const json = await client.download(item.resultId); if (alive.current) offerSourceResultDownload(json, item.resultId) })}>下载 JSON</Button></li>)}</ul>
      {cursor && <Button autoInsertSpace={false} disabled={busy} onClick={() => void run(async () => { const result = await client.list(cursor); if (alive.current) { setItems(current => [...current, ...result.items]); setCursor(result.nextCursor) } })}>加载更多结果</Button>}
      {page && <section aria-label="冻结结果预览"><h3>{page.artifact.name}</h3><p>时区 {page.timezone} · 第 {page.offset + 1}–{page.offset + page.rows.length} 行 / {page.totalRows} 行{page.sourceTruncated ? '（原查询已截断）' : ''}</p><p className="source-hash">SHA-256 {page.sha256}</p>
        <div className="source-results"><Table size="small" pagination={false} scroll={{x:'max-content'}} rowKey="__rowKey" dataSource={page.rows.map((row,index)=>({values:row,__rowKey:String(page.offset+index)}))} columns={page.schema.map(column=>({title:column.name+(column.unit ? `（${column.unit}）` : ''),key:column.name,render:(_value:unknown,record:{values:Record<string,unknown>})=>record.values[column.name]===null?'—':String(record.values[column.name]??'')}))}/></div>
        <Button autoInsertSpace={false} disabled={busy || page.offset === 0} onClick={() => void run(() => read(page.artifact.resultId, Math.max(0, page.offset - 1000)))}>上一批</Button>
        <Button autoInsertSpace={false} disabled={busy || page.nextOffset === null} onClick={() => void run(() => read(page.artifact.resultId, page.nextOffset!))}>下一批</Button>
      </section>}
      {error && <Alert type="error" showIcon title={error}/>}
    </div>
  </section></div>
}
