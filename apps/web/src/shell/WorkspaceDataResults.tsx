import './native-settings.css'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import {offerSourceResultDownload} from './source-result-download'
import type { SourceResultsClient } from './source-results-client'
import {isSourceResultName} from '../../../../packages/web-contracts/src/source-results.ts'
import type { WorkspaceSourceResultArtifact, WorkspaceSourceResultPage } from '../../../../packages/web-contracts/src/source-results.ts'
import { useI18n } from '../../../shell/src/renderer/src/locale'
import { translateSources, type SourcesStringKey } from './i18n/strings-sources'

const resultName = (item: WorkspaceSourceResultArtifact) =>
  item.name ?? `query-${item.sourceId}-${item.resultId.slice(0,8)}.json`

export function WorkspaceDataResults({ client, onClose, presentation = 'dialog' }: { client: SourceResultsClient; onClose: () => void; presentation?: 'dialog' | 'page'; onCloseGuardChange?: (guard: (() => boolean) | null) => void }) {
  const [items, setItems] = useState<WorkspaceSourceResultArtifact[]>([]), [cursor, setCursor] = useState<string | null>(null)
  const [page, setPage] = useState<WorkspaceSourceResultPage | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [revision, setRevision] = useState(0)
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('')
  const actionGroup = useId()
  const listRef = useRef<HTMLUListElement>(null)
  const focusAfterSave = useRef<string | null>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const term = filter.trim().toLowerCase()
  const visible = term ? items.filter(item =>
    resultName(item).toLowerCase().includes(term) || item.sourceId.toLowerCase().includes(term)
  ) : items
  const alive = useRef(true)
  // Translate at render time; never put `s` in a hook dependency list.
  const { lang } = useI18n()
  const savedDate = useMemo(() => new Intl.DateTimeFormat(lang, {
    dateStyle: 'medium', timeStyle: 'medium',
  }), [lang])
  const s = (key: SourcesStringKey, params?: Record<string, string | number>) => translateSources(lang, key, params)
  useEffect(() => {
    alive.current = true
    let live = true
    setLoading(true); setError(''); setNotice('')
    void client.list().then(result => { if (live) { setItems(result.items); setCursor(result.nextCursor); setPage(previous => result.items.some(item => item.resultId === previous?.artifact.resultId) ? previous : null) } }).catch(() => { if (live) setError('drLoadFailed') }).finally(() => { if (live) setLoading(false) })
    return () => { live = false; alive.current = false }
  }, [client, revision])
  useEffect(() => {
    const id = focusAfterSave.current
    if (!id || busy) return
    focusAfterSave.current = null
    const button = listRef.current?.querySelector<HTMLButtonElement>(`button[data-result-id="${id}"]`)
    const target = button ?? searchInput.current
    target?.focus()
  }, [busy,items])
  async function run(action: () => Promise<void>, failure: SourcesStringKey = 'drActionFailed') {
    if (busy) return
    setBusy(true); setError(''); setNotice('')
    try { await action() } catch { if (alive.current) setError(failure) }
    finally { if (alive.current) setBusy(false) }
  }
  async function read(resultId: string, offset = 0) { const value = await client.read(resultId, offset); if (alive.current) setPage(value) }
  async function save(item: WorkspaceSourceResultArtifact, name: string) {
    // Each snapshot can be saved once. Reuse its UUID for retries after a lost response.
    const saved = await client.save(item.resultId, name, item.resultId)
    if (!alive.current) return
    focusAfterSave.current = saved.resultId
    setNotice(s('drSaveDone',{name: saved.name ?? name}))
    setItems(current => current.map(entry => entry.resultId === saved.resultId ? saved : entry))
  }
  async function remove(item: WorkspaceSourceResultArtifact) {
    if (!window.confirm(s('drDeleteConfirm', { name: item.name ?? item.resultId }))) return
    await client.remove(item.resultId)
    if (!alive.current) return
    setItems(current => current.filter(entry => entry.resultId !== item.resultId))
    setPage(current => current?.artifact.resultId === item.resultId ? null : current)
    setNotice(s('drDeleted', { name: item.name ?? item.resultId }))
  }
  return <div className={presentation === 'page' ? 'workspace-panel-host' : 'set-overlay'}><section className={presentation === 'page' ? 'workspace-panel workspace-data-results-panel' : 'set-dialog source-dialog'} role={presentation === 'page' ? undefined : 'dialog'} aria-modal={presentation === 'page' ? undefined : true} aria-label={s('drTitle')}>
    {presentation === 'dialog' && <div className="set-header"><h2 className="set-title">{s('drTitle')}</h2><button type="button" className="native-settings-button" disabled={busy} onClick={onClose}>{s('srcCloseDialog')}</button></div>}
    <div className={presentation === 'page' ? 'workspace-panel-body' : 'set-body'}><div className="dr-toolbar">
      {(items.length > 0 || cursor || filter) && <>
        <input ref={searchInput} className="native-settings-input" type="search" aria-label={s('drSearch')} placeholder={s('drSearch')} value={filter} onChange={event => setFilter(event.target.value)}/>
        {filter && <button type="button" className="native-settings-button" onClick={() => {
          setFilter('')
          searchInput.current?.focus()
        }}>{s('srcClearFilters')}</button>}
        {term && items.length > 0 && <output>{visible.length} / {items.length}</output>}
      </>}
      <button type="button" className="native-settings-button dr-refresh" disabled={loading || busy} onClick={() => setRevision(value => value + 1)}>{s('srcRefreshList')}</button>
      </div>
      <p className="dr-intro">{s('drIntro')}</p>
      {loading && <p role="status">{s('drLoading')}</p>}
      {!loading && !items.length && !error && <p className="dr-empty">{s('drEmpty')}</p>}
      <ul ref={listRef} className="dr-list" aria-busy={loading || busy}>{visible.map(item => <li key={item.resultId}><div className="dr-identity"><button data-result-id={item.resultId} type="button" className="native-settings-button" disabled={busy || loading} aria-current={page?.artifact.resultId === item.resultId || undefined} aria-expanded={page?.artifact.resultId === item.resultId} onClick={() => {
          if (page?.artifact.resultId === item.resultId) setPage(null)
          else void run(() => read(item.resultId))
        }}>{resultName(item)}</button>
        <div className="dr-meta"><bdi>{item.sourceId}</bdi><span>{s('drRowCount', { count: item.rowCount })}{item.truncated ? s('drSourceTruncated') : ''}</span>
        {item.expiresAt && <span>{s('drExpiresAt')} <time dateTime={item.expiresAt}>{savedDate.format(new Date(item.expiresAt))}</time></span>}
        {item.savedAt && <span className="dr-saved">{s('drSavedAt')} <time dateTime={item.savedAt} title={item.savedAt}>{savedDate.format(new Date(item.savedAt))}</time></span>}</div></div>
        {item.state === 'pending' ? <form className="dr-save-form" onSubmit={event => {
          event.preventDefault()
          const input = event.currentTarget.elements.namedItem('name') as HTMLInputElement
          const name = input.value.trim()
          if (!isSourceResultName(name)) {
            input.setCustomValidity(s('drInvalidName'))
            input.reportValidity()
            return
          }
          void run(() => save(item,name), 'drSaveFailed')
        }}>
          <input className="native-settings-input" aria-label={s('srcNameColumn')} name="name" onInput={event => event.currentTarget.setCustomValidity('')} required maxLength={200} disabled={busy || loading} defaultValue={resultName(item)}/>
          <button type="submit" className="native-settings-button" disabled={busy || loading}>{s('drSaveResult')}</button>
        </form> : <details className="dr-row-actions" name={actionGroup}>
          <summary>{s('srcActionsColumn')}</summary>
          <div className="dr-actions">
        <button type="button" className="native-settings-button" disabled={busy || loading} onClick={() => void run(async () => { const json = await client.download(item.resultId); if (alive.current) offerSourceResultDownload(json, item.resultId) })}>{s('drDownloadJson')}</button>
        <button type="button" className="native-settings-button is-danger" aria-label={s('drDeleteAria', { name: item.name ?? item.resultId })} disabled={busy || loading} onClick={() => void run(() => remove(item), 'drDeleteFailed')}>{s('drDelete')}</button></div></details>}
      {page?.artifact.resultId === item.resultId && <section className="dr-preview" aria-label={s('drPreviewLabel')}><p>{s('drPageRange', { timezone: page.timezone, from: page.rows.length ? page.offset + 1 : 0, to: page.offset + page.rows.length, total: page.totalRows })}{page.sourceTruncated ? s('drOriginalTruncated') : ''}</p>
        <div className="source-results" role="region" aria-label={s('drPreviewLabel')} tabIndex={0}><table><thead><tr>{page.schema.map(column=><th key={column.name} scope="col" data-type={column.type}>{column.unit?s('drColumnWithUnit',{name:column.name,unit:column.unit}):column.name}</th>)}</tr></thead><tbody>{page.rows.map((row,index)=><tr key={page.offset+index}>{page.schema.map(column=><td key={column.name} data-type={column.type}>{row[column.name]===null?'—':String(row[column.name]??'')}</td>)}</tr>)}</tbody></table></div>
        {(page.offset > 0 || page.nextOffset !== null) && <div className="dr-pager"><button type="button" className="native-settings-button" disabled={busy || loading || page.offset === 0} onClick={() => void run(() => read(page.artifact.resultId, Math.max(0, page.offset - 1000)))}>{s('drPreviousBatch')}</button>
        <button type="button" className="native-settings-button" disabled={busy || loading || page.nextOffset === null} onClick={() => void run(() => read(page.artifact.resultId, page.nextOffset!))}>{s('drNextBatch')}</button></div>}
        <details className="dr-checksum"><summary>SHA-256</summary><code>{page.sha256}</code></details>
      </section>}
      </li>)}</ul>
      {cursor && <button type="button" className="native-settings-button" disabled={busy || loading} onClick={() => void run(async () => { const result = await client.list(cursor); if (alive.current) { setItems(current => [...current, ...result.items]); setCursor(result.nextCursor) } })}>{s('drLoadMore')}</button>}
      {notice && <p role="status" className="native-settings-notice">{notice}</p>}
      {error && <p role="alert" className="native-settings-notice is-error">{s(error as SourcesStringKey)}</p>}
    </div>
  </section></div>
}
