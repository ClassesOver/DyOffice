import { useEffect, useRef, useState } from 'react'
import type { SourceDetail, SourceDescriptor, SourceConfig, SourceKind, QuerySnapshot } from '../../../../packages/web-contracts/src/sources.ts'
import type { SourcesClient } from './sources-client'

type Draft = { sourceId: string; name: string; kind: SourceKind; config: string; credentialMode: 'retain' | 'replace' | 'clear'; secret: string; enabled: boolean }
const empty = (): Draft => ({ sourceId: '', name: '', kind: 'http', config: '{\n  "timezone": "UTC",\n  "maxRows": 1000,\n  "units": {}\n}', credentialMode: 'replace', secret: '', enabled: true })
const fromDetail = (detail: SourceDetail): Draft => ({ sourceId: detail.source.sourceId, name: detail.source.name, kind: detail.source.kind,
  config: JSON.stringify(detail.config, null, 2), credentialMode: 'retain', secret: '', enabled: detail.source.enabled })

export function SourcesPanel({ client, onClose }: { client: SourcesClient; onClose: () => void }) {
  const [items, setItems] = useState<SourceDescriptor[]>([]), [cursor, setCursor] = useState<string | null>(null)
  const [detail, setDetail] = useState<SourceDetail | null>(null), [latest, setLatest] = useState<SourceDetail | null>(null)
  const [draft, setDraft] = useState<Draft>(empty), [dirty, setDirty] = useState(false), [confirmDelete, setConfirmDelete] = useState(false)
  const [result, setResult] = useState<QuerySnapshot | null>(null), [sql, setSql] = useState('SELECT 1 AS value')
  const [message, setMessage] = useState(''), [error, setError] = useState(''), [, tick] = useState(0)
  const alive = useRef(true), busy = client.getState().pending, unknown = client.getState().unknownWrite
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    alive.current = true
    const unsubscribe = client.subscribe(() => { if (alive.current) tick(n => n + 1) })
    void client.list().then(page => { if (alive.current) { setItems(page.items); setCursor(page.nextCursor) } }).catch(e => { if (alive.current) setError(e.message) })
    return () => { alive.current = false; unsubscribe(); if (inputRef.current) inputRef.current.value = '' }
  }, [client])
  const patch = (value: Partial<Draft>) => { setDraft(current => ({ ...current, ...value })); setDirty(true); setLatest(null); setConfirmDelete(false) }
  async function operation(action: () => Promise<void>) {
    if (busy) return
    setError(''); setMessage('')
    try { await action() } catch (e) { if (alive.current) setError((e as Error).message) }
    finally { if (alive.current) { setDraft(current => ({ ...current, secret: '' })); if (inputRef.current) inputRef.current.value = '' } }
  }
  async function reloadList(append = false) {
    const page = await client.list(append ? cursor ?? undefined : undefined)
    if (alive.current) { setItems(current => append ? [...current, ...page.items] : page.items); setCursor(page.nextCursor) }
  }
  async function select(sourceId: string) {
    const value = await client.detail(sourceId)
    if (alive.current) { setDetail(value); setDraft(fromDetail(value)); setLatest(null); setDirty(false); setResult(null); setConfirmDelete(false) }
  }
  async function save() {
    let config: SourceConfig
    try {
      const value: unknown = JSON.parse(draft.config)
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('invalid')
      config = value as SourceConfig
    } catch { throw Error('公开配置必须是有效的 JSON 对象，不能包含连接地址或密码。') }
    if (!detail) {
      if (!draft.secret) throw Error('创建数据源必须填写连接凭据。')
      await client.create({ sourceId: draft.sourceId, name: draft.name, kind: draft.kind, config, secret: draft.secret })
    } else await client.save(detail.source.sourceId, { expectedVersion: detail.source.version, name: draft.name, config, enabled: draft.enabled,
      ...(draft.credentialMode === 'replace' ? { secret: draft.secret } : draft.credentialMode === 'clear' ? { secret: null } : {}) })
    if (!alive.current) return
    await select(draft.sourceId); await reloadList()
    if (alive.current) setMessage('草稿已保存，查询仍使用已发布版本。')
  }
  return <div className="set-overlay"><section className="set-dialog source-dialog" role="dialog" aria-modal="true" aria-label="数据源管理">
    <div className="set-header"><h2 className="set-title">数据源管理</h2><button className="set-btn" disabled={busy} onClick={onClose}>关闭</button></div>
    <div className="set-body source-body">
      <aside className="source-list" aria-label="数据源列表">
        <button className="set-btn" disabled={busy || dirty} onClick={() => { setDetail(null); setDraft(empty()); setDirty(false); setLatest(null); setResult(null); setConfirmDelete(false) }}>新建数据源</button>
        {items.map(item => <button className="set-btn source-item" key={item.sourceId} disabled={busy || dirty} onClick={() => void operation(() => select(item.sourceId))}>
          <strong>{item.name}</strong><span>{item.kind} · 草稿 v{item.version} · {item.publishedRevision ? `已发布 r${item.publishedRevision}` : '未发布'}</span><span>{item.enabled ? '已启用' : '已禁用'}{item.hasUnpublishedChanges ? ' · 有未发布修改' : ''}</span>
        </button>)}
        {cursor && <button className="set-btn" disabled={busy} onClick={() => void operation(() => reloadList(true))}>加载更多</button>}
        <button className="set-btn" disabled={busy} onClick={() => void operation(() => reloadList())}>刷新列表</button>
      </aside>
      <main className="source-editor">
        <p className="set-pane-desc">连接地址与凭据加密保存且不回显。先保存草稿、测试连接，再发布；查询只使用已发布版本。目标数据库账号须由管理员授予最小只读权限。</p>
        {dirty && <p role="status">当前有未保存草稿，切换数据源前请保存或明确放弃。</p>}
        {unknown && <p role="alert">上次写入结果未确认，已停止后续写入。读取最新版本并核对后再操作。</p>}
        <fieldset disabled={busy || unknown} className="source-fields">
          <label className="set-field">标识<input aria-label="数据源标识" value={draft.sourceId} disabled={!!detail} maxLength={64} onChange={e => patch({ sourceId: e.target.value })} /></label>
          <label className="set-field">名称<input aria-label="数据源名称" value={draft.name} maxLength={200} onChange={e => patch({ name: e.target.value })} /></label>
          <label className="set-field">连接器<select aria-label="连接器" value={draft.kind} disabled={!!detail} onChange={e => patch({ kind: e.target.value as SourceKind })}>
            <option value="http">HTTP JSON</option><option value="postgres">PostgreSQL</option><option value="mysql">MySQL</option><option value="starrocks">StarRocks</option>
          </select></label>
          <label className="set-field">公开配置 JSON<textarea aria-label="公开配置 JSON" rows={7} spellCheck={false} value={draft.config} onChange={e => patch({ config: e.target.value })} /></label>
          {detail && <label className="set-field">凭据操作<select aria-label="凭据操作" value={draft.credentialMode} onChange={e => patch({ credentialMode: e.target.value as Draft['credentialMode'], secret: '' })}>
            <option value="retain">保留现有凭据{detail.source.hasCredential ? '（已配置）' : '（未配置）'}</option><option value="replace">替换凭据</option><option value="clear">清空草稿凭据</option>
          </select></label>}
          {(!detail || draft.credentialMode === 'replace') && <label className="set-field">{draft.kind === 'http' ? 'HTTP JSON 端点 URL' : '数据库只读 DSN'}<input ref={inputRef} aria-label="连接凭据" type="password" autoComplete="new-password" value={draft.secret} onChange={e => patch({ secret: e.target.value })} /></label>}
          <label className="set-field"><input type="checkbox" checked={draft.enabled} onChange={e => patch({ enabled: e.target.checked })} />启用数据源</label>
          <button className="set-btn primary" onClick={() => void operation(save)}>保存草稿</button>
        </fieldset>
        <div className="source-actions">
          {detail && <>
            <button className="set-btn" disabled={busy} onClick={() => void operation(async () => { const current = await client.detail(detail.source.sourceId); if (alive.current) { setLatest(current); setMessage('最新版本已读取，当前草稿仍保留。') } })}>读取最新版本并核对</button>
            <button className="set-btn" disabled={busy || dirty || unknown} onClick={() => void operation(async () => { const checked = await client.test(detail.source.sourceId); if (alive.current) setMessage(checked.ok ? '连接测试通过。' : '连接测试未通过，请检查目标只读权限与部署网络策略。') })}>测试已保存草稿</button>
            <button className="set-btn" disabled={busy || dirty || unknown || !detail.source.hasCredential} onClick={() => void operation(async () => { await client.publish(detail.source.sourceId, detail.source.version); if (!alive.current) return; await select(detail.source.sourceId); await reloadList(); if (alive.current) setMessage('数据源版本已发布。') })}>发布草稿</button>
            <label><input type="checkbox" checked={confirmDelete} disabled={busy || unknown} onChange={e => setConfirmDelete(e.target.checked)} />确认删除此数据源与其版本记录</label>
            <button className="set-btn danger" disabled={busy || unknown || !confirmDelete} onClick={() => void operation(async () => { await client.remove(detail.source.sourceId); if (!alive.current) return; setDetail(null); setDraft(empty()); setDirty(false); await reloadList() })}>删除数据源</button>
          </>}
          {dirty && <button className="set-btn" disabled={busy} onClick={() => { setDraft(detail ? fromDetail(detail) : empty()); setDirty(false); setLatest(null) }}>放弃本地草稿</button>}
        </div>
        {latest && <div role="status"><p>服务器最新草稿 v{latest.source.version}；本地编辑基于 v{detail?.source.version}。</p><button className="set-btn" onClick={() => { client.acknowledgeLatest(); setDetail(latest); setDraft(fromDetail(latest)); setDirty(false); setLatest(null) }}>采用服务器版本并放弃当前草稿</button></div>}
        {detail?.published && <section><h3>查询已发布版本 r{detail.published.revision}</h3>
          {draft.kind !== 'http' && <label className="set-field">只读 SQL<textarea aria-label="只读 SQL" rows={4} spellCheck={false} value={sql} onChange={e => setSql(e.target.value)} /></label>}
          <button className="set-btn" disabled={busy || unknown || !detail.source.enabled} onClick={() => void operation(async () => { const snapshot = await client.query(detail.source.sourceId, draft.kind === 'http' ? {} : { sql }); if (alive.current) setResult(snapshot) })}>执行已发布查询</button>
        </section>}
        {result && <section aria-label="查询结果"><p>来源 {result.sourceId} r{result.sourceVersion} · 时区 {result.timezone} · {result.rows.length} 行{result.truncated ? '（结果已截断）' : ''}</p><p className="source-hash">SHA-256 {result.sha256}</p>
          <div className="source-results"><table><thead><tr>{result.schema.map(column => <th key={column.name}>{column.name}{column.unit ? `（${column.unit}）` : ''}</th>)}</tr></thead><tbody>{result.rows.slice(0,100).map((row,index) => <tr key={index}>{result.schema.map(column => <td key={column.name}>{row[column.name] === null ? '—' : String(row[column.name] ?? '')}</td>)}</tr>)}</tbody></table></div>
          {result.rows.length > 100 && <p>界面仅显示前 100 行，完整受限结果共 {result.rows.length} 行。</p>}
        </section>}
        {message && <p role="status">{message}</p>}{error && <p role="alert">{error}</p>}
      </main>
    </div>
  </section></div>
}
