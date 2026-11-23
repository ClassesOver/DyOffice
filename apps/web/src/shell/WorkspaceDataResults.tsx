import './native-settings.css'
import { useEffect, useRef, useState } from 'react'
import {offerSourceResultDownload} from './source-result-download'
import type { SourceResultsClient } from './source-results-client'
import type { WorkspaceSourceResultArtifact, WorkspaceSourceResultPage } from '../../../../packages/web-contracts/src/source-results.ts'
import { useI18n } from '../../../shell/src/renderer/src/locale'
import { translateSources, type SourcesStringKey } from './i18n/strings-sources'

export function WorkspaceDataResults({ client, onClose, presentation = 'dialog' }: { client: SourceResultsClient; onClose: () => void; presentation?: 'dialog' | 'page'; onCloseGuardChange?: (guard: (() => boolean) | null) => void }) {
  const [items, setItems] = useState<WorkspaceSourceResultArtifact[]>([]), [cursor, setCursor] = useState<string | null>(null)
  const [page, setPage] = useState<WorkspaceSourceResultPage | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const alive = useRef(true)
  // Translate at render time; never put `s` in a hook dependency list.
  const { lang } = useI18n()
  const s = (key: SourcesStringKey, params?: Record<string, string | number>) => translateSources(lang, key, params)
  useEffect(() => {
    alive.current = true
    let live = true
    void client.list().then(result => { if (live) { setItems(result.items); setCursor(result.nextCursor) } }).catch(() => { if (live) setError('drLoadFailed') })
    return () => { live = false; alive.current = false }
  }, [client])
  async function run(action: () => Promise<void>, failure: SourcesStringKey = 'drActionFailed') {
    if (busy) return
    setBusy(true); setError(''); setNotice('')
    try { await action() } catch { if (alive.current) setError(failure) }
    finally { if (alive.current) setBusy(false) }
  }
  async function read(resultId: string, offset = 0) { const value = await client.read(resultId, offset); if (alive.current) setPage(value) }
  async function remove(item: WorkspaceSourceResultArtifact) {
    if (!window.confirm(s('drDeleteConfirm', { name: item.name ?? item.resultId }))) return
    await client.remove(item.resultId)
    if (!alive.current) return
    setItems(current => current.filter(entry => entry.resultId !== item.resultId))
    setPage(current => current?.artifact.resultId === item.resultId ? null : current)
    setNotice(s('drDeleted', { name: item.name ?? item.resultId }))
  }
  return <div className={presentation === 'page' ? 'workspace-panel-host' : 'set-overlay'}><section className={presentation === 'page' ? 'workspace-panel workspace-data-results-panel' : 'set-dialog source-dialog'} role={presentation === 'page' ? undefined : 'dialog'} aria-modal={presentation === 'page' ? undefined : true} aria-label={s('drTitle')}>
    <div className={presentation === 'page' ? 'workspace-panel-header' : 'set-header'}><h2 className="set-title">{s('drTitle')}</h2><button type="button" className="native-settings-button" disabled={presentation === 'dialog' && busy} onClick={onClose}>{s('srcCloseDialog')}</button></div>
    <div className={presentation === 'page' ? 'workspace-panel-body' : 'set-body'}><p>{s('drIntro')}</p>
      <ul>{items.map(item => <li key={item.resultId}><button type="button" className="native-settings-button" disabled={busy} onClick={() => void run(() => read(item.resultId))}>{item.name}</button>
        <span> {item.sourceId} · {s('drRowCount', { count: item.rowCount })}{item.truncated ? s('drSourceTruncated') : ''}</span>
        <button type="button" className="native-settings-button" disabled={busy} onClick={() => void run(async () => { const json = await client.download(item.resultId); if (alive.current) offerSourceResultDownload(json, item.resultId) })}>{s('drDownloadJson')}</button>
        <button type="button" className="native-settings-button" aria-label={s('drDeleteAria', { name: item.name ?? item.resultId })} disabled={busy} onClick={() => void run(() => remove(item), 'drDeleteFailed')}>{s('drDelete')}</button></li>)}</ul>
      {cursor && <button type="button" className="native-settings-button" disabled={busy} onClick={() => void run(async () => { const result = await client.list(cursor); if (alive.current) { setItems(current => [...current, ...result.items]); setCursor(result.nextCursor) } })}>{s('drLoadMore')}</button>}
      {page && <section aria-label={s('drPreviewLabel')}><h3>{page.artifact.name}</h3><p>{s('drPageRange', { timezone: page.timezone, from: page.offset + 1, to: page.offset + page.rows.length, total: page.totalRows })}{page.sourceTruncated ? s('drOriginalTruncated') : ''}</p><p className="source-hash">SHA-256 {page.sha256}</p>
        <div className="source-results"><table><thead><tr>{page.schema.map(column=><th key={column.name} scope="col">{column.unit?s('drColumnWithUnit',{name:column.name,unit:column.unit}):column.name}</th>)}</tr></thead><tbody>{page.rows.map((row,index)=><tr key={page.offset+index}>{page.schema.map(column=><td key={column.name}>{row[column.name]===null?'—':String(row[column.name]??'')}</td>)}</tr>)}</tbody></table></div>
        <button type="button" className="native-settings-button" disabled={busy || page.offset === 0} onClick={() => void run(() => read(page.artifact.resultId, Math.max(0, page.offset - 1000)))}>{s('drPreviousBatch')}</button>
        <button type="button" className="native-settings-button" disabled={busy || page.nextOffset === null} onClick={() => void run(() => read(page.artifact.resultId, page.nextOffset!))}>{s('drNextBatch')}</button>
      </section>}
      {notice && <p role="status" className="native-settings-notice">{notice}</p>}
      {error && <p role="alert" className="native-settings-notice is-error">{s(error as SourcesStringKey)}</p>}
    </div>
  </section></div>
}
