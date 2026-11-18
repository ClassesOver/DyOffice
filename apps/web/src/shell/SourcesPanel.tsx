import {Button, Input, Checkbox, Alert, Table, Select, Tag, Space, type InputRef} from 'antd'
import { useEffect, useRef, useState } from 'react'
import './workspace-panels.css'
import './connection-config-b.css'
import {SettingsListPager} from './SettingsListPager'
import {offerSourceResultDownload} from './source-result-download'
import type { SourceDetail, SourceDescriptor, SourceConfig, SourceKind, QuerySnapshot } from '../../../../packages/web-contracts/src/sources.ts'
import type { SourcesClient } from './sources-client'
import type { SourceResultsClient } from './source-results-client'
import type { SourceToolQueryOutcome } from '../../../../packages/web-contracts/src/source-tools.ts'
import type { WorkspaceSourceResultArtifact } from '../../../../packages/web-contracts/src/source-results.ts'

type Draft = { sourceId: string; name: string; kind: SourceKind; config: string; credentialMode: 'retain' | 'replace' | 'clear'; secret: string; enabled: boolean }
const empty = (): Draft => ({ sourceId: '', name: '', kind: 'postgres', config: '{\n  "timezone": "UTC",\n  "maxRows": 1000,\n  "units": {}\n}', credentialMode: 'replace', secret: '', enabled: true })
const fromDetail = (detail: SourceDetail): Draft => ({ sourceId: detail.source.sourceId, name: detail.source.name, kind: detail.source.kind,
  config: JSON.stringify(detail.config, null, 2), credentialMode: 'retain', secret: '', enabled: detail.source.enabled })

export function SourcesPanel({ client, resultsClient, onClose, presentation = 'dialog', onCloseGuardChange }: { client: SourcesClient; resultsClient?: SourceResultsClient; onClose: () => void; presentation?: 'dialog' | 'page'; onCloseGuardChange?: (guard: (() => boolean) | null) => void }) {
  const [items, setItems] = useState<SourceDescriptor[]>([]), [cursor, setCursor] = useState<string | null>(null)
  const [listPage,setListPage]=useState(0),[pageStarts,setPageStarts]=useState<(string|undefined)[]>([undefined])
  const [detail, setDetail] = useState<SourceDetail | null>(null), [latest, setLatest] = useState<SourceDetail | null>(null)
  const [missing, setMissing] = useState<string|null>(null)
  const [draft, setDraft] = useState<Draft>(empty), [confirmDelete, setConfirmDelete] = useState(false)
  const [queryFailed, setQueryFailed] = useState(false)
  const [resultPage,setResultPage]=useState(0)
  const [result, setResult] = useState<QuerySnapshot | null>(null), [sql, setSql] = useState('SELECT 1 AS value')
  const [capture, setCapture] = useState<SourceToolQueryOutcome | null>(null), [savedResult, setSavedResult] = useState<WorkspaceSourceResultArtifact | null>(null)
  const [resultName, setResultName] = useState('查询结果'), [resultBusy, setResultBusy] = useState(false)
  const [filter, setFilter] = useState('')
  const saveIntent = useRef<{ resultId: string; commandId: string; name: string; unknown: boolean } | null>(null)
  const [message, setMessage] = useState(''), [error, setError] = useState(''), [, tick] = useState(0)
  const alive = useRef(true), busy = client.getState().pending || resultBusy, unknown = client.getState().unknownWrite
  const inputRef = useRef<InputRef>(null)
  useEffect(() => {
    alive.current = true
    const unsubscribe = client.subscribe(() => { if (alive.current) tick(n => n + 1) })
    void client.list().then(page => { if (alive.current) { setItems(page.items); setCursor(page.nextCursor); setListPage(0); setPageStarts([undefined]) } }).catch(e => { if (alive.current) setError(e.message) })
    return () => { alive.current = false; unsubscribe(); if (inputRef.current) inputRef.current.input && (inputRef.current.input.value = '') }
  }, [client])
  const legacyHttp = detail?.source.kind === 'http'
  const visibleItems = items.filter(item => `${item.name} ${item.sourceId} ${item.kind}`.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()))
  const dirty = JSON.stringify(draft) !== JSON.stringify(detail ? fromDetail(detail) : empty())
  const unresolvedResult = !!saveIntent.current && !savedResult
  function canClose() {
    if (client.getState().pending || resultBusy) { setError('连接操作处理中，请完成后再关闭。'); return false }
    if (client.getState().unknownWrite || unresolvedResult) { setError('操作结果尚未确认，请先核对或确认保存结果后再关闭。'); return false }
    return !dirty || window.confirm('当前有未保存的连接草稿，确定放弃并关闭？')
  }
  useEffect(() => {
    onCloseGuardChange?.(busy || unknown || dirty || unresolvedResult ? canClose : null)
    return () => onCloseGuardChange?.(null)
  }, [onCloseGuardChange, busy, unknown, dirty, unresolvedResult])
  useEffect(() => {
    if (!busy && !unknown && !dirty && !unresolvedResult) return
    const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', prevent)
    return () => window.removeEventListener('beforeunload', prevent)
  }, [busy, unknown, dirty, unresolvedResult])
  const patch = (value: Partial<Draft>) => { setDraft(current => ({ ...current, ...value })); setLatest(null); setConfirmDelete(false) }
  let publicConfig: Record<string, unknown> | null = null
  try { const value = JSON.parse(draft.config); if (value && typeof value === 'object' && !Array.isArray(value)) publicConfig = value } catch { /* Advanced JSON validation is reported on save. */ }
  function patchConfig(key: string, value: string | number) {
    if (publicConfig) patch({config: JSON.stringify({...publicConfig, [key]: value}, null, 2)})
  }
  async function operation(action: () => Promise<void>, clearSubmittedSecret = false) {
    if (busy) return
    setError(''); setMessage('')
    try { await action() } catch (e) { if (alive.current) setError((e as Error).message) }
    finally { if (alive.current && clearSubmittedSecret) { setDraft(current => ({ ...current, secret: '' })); if (inputRef.current) inputRef.current.input && (inputRef.current.input.value = '') } }
  }
  async function reloadList(targetPage=0,after?:string) {
    const page = await client.list(after)
    if (alive.current) { setItems(page.items); setCursor(page.nextCursor); setListPage(targetPage); setPageStarts(old=>targetPage===0?[undefined]:[...old.slice(0,targetPage),after]) }
  }
  function changeListPage(next:number) {
    if(client.getState().pending||resultBusy||dirty||client.getState().unknownWrite||unresolvedResult)return
    if(next===listPage+1&&cursor)void operation(()=>reloadList(next,cursor))
    else if(next===listPage-1&&next>=0)void operation(()=>reloadList(next,pageStarts[next]))
  }
  async function select(sourceId: string) {
    const value = await client.detail(sourceId)
    if (alive.current) { setDetail(value); setDraft(fromDetail(value)); setLatest(null); setMissing(null); setResult(null); setResultPage(0); setQueryFailed(false); setCapture(null); setSavedResult(null); saveIntent.current = null; setConfirmDelete(false) }
  }
  async function readLatest(sourceId:string){
    setMissing(null)
    try{const current=await client.detail(sourceId);if(alive.current){setLatest(current);setMessage('最新版本已读取，当前草稿仍保留。')}}
    catch(error){if((error as {status?:number}).status!==404)throw error;if(alive.current){setLatest(null);setMissing(sourceId)}}
  }
  async function save() {
    if (legacyHttp || draft.kind === 'http') throw Error('已有 HTTP 连接仅支持只读查看，请新建数据库连接。')
    let config: SourceConfig
    try {
      const value: unknown = JSON.parse(draft.config)
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('invalid')
      config = value as SourceConfig
    } catch { throw Error('公开配置必须是有效的 JSON 对象，不能包含连接地址或密码。') }
    if (!detail) {
      if (!draft.secret) throw Error('创建连接必须填写连接凭据。')
      await client.create({ sourceId: draft.sourceId, name: draft.name, kind: draft.kind, config, secret: draft.secret })
    } else await client.save(detail.source.sourceId, { expectedVersion: detail.source.version, name: draft.name, config, enabled: draft.enabled,
      ...(draft.credentialMode === 'replace' ? { secret: draft.secret } : draft.credentialMode === 'clear' ? { secret: null } : {}) })
    if (!alive.current) return
    await select(draft.sourceId); await reloadList()
    if (alive.current) setMessage('草稿已保存，查询仍使用已发布版本。')
  }
  return <div className={presentation === 'page' ? 'workspace-panel-host' : 'set-overlay'}><section className={presentation === 'page' ? 'workspace-panel workspace-sources-panel sources-panel-b' : 'set-dialog source-dialog sources-panel-b'} role={presentation === 'page' ? undefined : 'dialog'} aria-modal={presentation === 'page' ? undefined : true} aria-label="数据连接">
    {presentation==='dialog'&&<div className="set-header"><h2 className="set-title">数据连接</h2><Button autoInsertSpace={false} disabled={busy} onClick={() => { if (canClose()) onClose() }}>关闭</Button></div>}
    {error && <Alert type="error" showIcon title={error}/> }
    <div className={presentation === 'page' ? 'workspace-panel-body source-body' : 'set-body source-body'}>
      <aside className="source-list" aria-label="连接列表">
        <div className="source-list-summary"><strong>数据连接</strong><span>当前页 {items.length} 个连接</span><Tag color={items.filter(item => item.enabled).length ? 'green' : 'default'}>{items.filter(item => item.enabled).length} 个已启用</Tag></div>
        <Input.Search aria-label="搜索数据连接" placeholder="搜索当前页名称或标识" allowClear value={filter} disabled={busy} onChange={event => setFilter(event.target.value)}/>
        <Button autoInsertSpace={false} type="primary" disabled={busy || dirty || unknown || unresolvedResult} onClick={() => { setDetail(null); setDraft(empty()); setLatest(null); setResult(null); setConfirmDelete(false) }}>新建数据连接</Button>
        {visibleItems.map(item => <Button autoInsertSpace={false} className="source-item" aria-pressed={detail?.source.sourceId === item.sourceId} key={item.sourceId} disabled={busy || dirty || unresolvedResult} onClick={() => { if (!unresolvedResult) void operation(() => select(item.sourceId)) }}>
          <strong>{item.name}</strong><span>{item.kind} · 草稿 v{item.version} · {item.publishedRevision ? `已发布 r${item.publishedRevision}` : '未发布'}</span><span>{item.enabled ? '已启用' : '已禁用'}{item.hasUnpublishedChanges ? ' · 有未发布修改' : ''}</span>
        </Button>)}
        {!visibleItems.length && <div className="source-list-empty"><span>{filter ? '没有匹配的连接' : '尚未配置数据连接'}</span>{filter && <Button autoInsertSpace={false} type="link" onClick={() => setFilter('')}>清除筛选</Button>}</div>}
        <SettingsListPager page={listPage} pageSize={50} hasPrevious={listPage>0} hasNext={!!cursor} label="数据连接" onPageChange={changeListPage} disabled={busy||dirty||unknown||unresolvedResult}/>
        <Space className="source-list-footer" wrap><Button autoInsertSpace={false} disabled={busy} onClick={() => void operation(() => reloadList())}>刷新列表</Button>{filter && <Button autoInsertSpace={false} type="link" onClick={() => setFilter('')}>清除筛选</Button>}</Space>
      </aside>
      <main className="source-editor">
        <div className="source-workbench-heading"><div><h3>{detail ? detail.source.name : '新建数据连接'}</h3><p>{detail ? `${detail.source.sourceId} · 草稿 v${detail.source.version}` : '配置连接与查询范围，保存后测试并发布。'}</p></div><Space wrap>{detail && <Tag color={detail.source.enabled ? 'green' : 'default'}>{detail.source.enabled ? '已启用' : '已停用'}</Tag>}{detail && <span className="source-version-badge">{detail.source.publishedRevision ? `生效版本 r${detail.source.publishedRevision}` : '尚未发布'}</span>}</Space></div>
        <p className="set-pane-desc">连接地址与凭据加密保存且不回显。先保存草稿、测试连接，再发布；查询只使用已发布版本。目标数据库账号须由管理员授予最小只读权限。</p>
        {legacyHttp && <Alert type="info" showIcon title="已有 HTTP 连接仅支持只读查看与执行已发布查询。新建连接仅支持 PostgreSQL、MySQL 和 StarRocks。"/>}
        {dirty && <p role="status">当前有未保存草稿，切换连接前请保存或明确放弃。</p>}
        {unknown && <p role="alert">上次写入结果未确认，已停止后续写入。请读取「{client.getState().unknownSourceId}」的最新版本并核对后再操作。</p>}
        <fieldset disabled={busy || unknown || legacyHttp} className="source-fields">
          <label className="set-field">标识<Input aria-label="连接标识" value={draft.sourceId} disabled={!!detail || busy || unknown || legacyHttp} maxLength={64} onChange={e => patch({ sourceId: e.target.value })} /></label>
          <label className="set-field">名称<Input aria-label="连接名称" disabled={busy || unknown || legacyHttp} value={draft.name} maxLength={200} onChange={e => patch({ name: e.target.value })} /></label>
          <label className="set-field">连接器<Select aria-label="连接器" value={draft.kind} disabled={!!detail || busy || unknown} onChange={value => patch({kind: value as SourceKind})} options={[...(legacyHttp?[{value:'http',label:'HTTP JSON（只读）'}]:[]),{value:'postgres',label:'PostgreSQL'},{value:'mysql',label:'MySQL'},{value:'starrocks',label:'StarRocks'}]}/></label>
          <label className="set-field">时区<Input aria-label="时区" placeholder="如 Asia/Shanghai" disabled={!publicConfig || busy || unknown || legacyHttp} value={typeof publicConfig?.timezone === 'string' ? publicConfig.timezone : ''} onChange={e => patchConfig('timezone', e.target.value)}/></label>
          <label className="set-field">查询最大行数<Input aria-label="查询最大行数" type="number" min={1} step={1} disabled={!publicConfig || busy || unknown || legacyHttp} value={typeof publicConfig?.maxRows === 'number' ? publicConfig.maxRows : ''} onChange={e => patchConfig('maxRows', Number(e.target.value))}/></label>
          <details className="source-advanced"><summary>高级配置（公开 JSON 与字段单位）</summary><label className="set-field">公开配置 JSON<Input.TextArea aria-label="公开配置 JSON" disabled={busy || unknown || legacyHttp} rows={7} spellCheck={false} value={draft.config} onChange={e => patch({ config: e.target.value })} /></label><p>仅填写公开查询配置；连接地址与密码请使用下方凭据字段。</p></details>
          {detail && !legacyHttp && <label className="set-field">凭据操作<Select aria-label="凭据操作" value={draft.credentialMode} disabled={busy || unknown} onChange={value => patch({credentialMode:value as Draft['credentialMode'],secret:''})} options={[{value:'retain',label:`保留现有凭据${detail.source.hasCredential ? '（已配置）' : '（未配置）'}`},{value:'replace',label:'替换凭据'},{value:'clear',label:'清空草稿凭据'}]}/></label>}
          {!legacyHttp && (!detail || draft.credentialMode === 'replace') && <label className="set-field">{draft.kind === 'http' ? 'HTTP JSON 端点 URL' : '数据库只读 DSN'}<Input ref={inputRef} aria-label="连接凭据" type="password" autoComplete="new-password" value={draft.secret} onChange={e => patch({ secret: e.target.value })} /></label>}
          <label className="set-field"><Checkbox disabled={busy || unknown || legacyHttp} checked={draft.enabled} onChange={e => patch({ enabled: e.target.checked })}>启用数据连接</Checkbox></label>
          <Button autoInsertSpace={false} type="primary" disabled={busy || unknown || legacyHttp || unresolvedResult} onClick={() => { if (!unresolvedResult) void operation(save, true) }}>保存草稿</Button>
        </fieldset>
        <div className="source-actions">
          {unknown&&client.getState().unknownSourceId&&client.getState().unknownSourceId!==(detail?.source.sourceId??draft.sourceId)&&<Button autoInsertSpace={false} disabled={busy} onClick={()=>void operation(()=>readLatest(client.getState().unknownSourceId!))}>读取待核对连接（{client.getState().unknownSourceId}）</Button>}
          {(detail || unknown && draft.sourceId) && <Button autoInsertSpace={false} disabled={busy} onClick={() => void operation(() => readLatest(detail?.source.sourceId ?? draft.sourceId))}>读取最新版本并核对</Button>}
          {detail && <>
            <Button autoInsertSpace={false} disabled={busy || dirty || unknown || legacyHttp} onClick={() => void operation(async () => { const checked = await client.test(detail.source.sourceId); if (alive.current) { if (checked.ok) setMessage('连接测试通过。'); else setError(checked.code === 'READONLY_ROLE_REQUIRED' ? '连接账号未通过最小只读权限核验。请使用仅获批准库 SELECT 权限的专用账号，不能使用 root 或管理角色。' : checked.code === 'SOURCE_TIMEOUT' ? '连接或查询超时，请检查目标网络与查询时限。' : '连接测试未通过，请检查目标只读权限与部署网络策略。') } })}>测试已保存草稿</Button>
            <Button autoInsertSpace={false} disabled={busy || dirty || unknown || legacyHttp || unresolvedResult || !detail.source.hasCredential} onClick={() => void operation(async () => { await client.publish(detail.source.sourceId, detail.source.version); if (!alive.current) return; await select(detail.source.sourceId); await reloadList(); if (alive.current) setMessage('连接版本已发布。') })}>发布草稿</Button>
            <label><Checkbox aria-label="确认删除此连接" checked={confirmDelete} disabled={busy || unknown || legacyHttp} onChange={e => setConfirmDelete(e.target.checked)}>确认删除此连接（保留不可复用的标识墓碑）</Checkbox></label>
            <Button autoInsertSpace={false} danger disabled={busy || unknown || legacyHttp || unresolvedResult || !confirmDelete} onClick={() => void operation(async () => { await client.remove(detail.source.sourceId, detail.source.version); if (!alive.current) return; setDetail(null); setDraft(empty()); await reloadList() })}>删除连接</Button>
          </>}
          {dirty && <Button autoInsertSpace={false} disabled={busy || unknown} onClick={() => { setDraft(detail ? fromDetail(detail) : empty()); setLatest(null) }}>放弃本地草稿</Button>}
        </div>
        {missing && <div role="status"><p>服务器确认此连接已不存在。当前本地草稿仍保留。</p><Button autoInsertSpace={false} disabled={busy} onClick={() => { client.acknowledgeLatest(missing); setDetail(null); setDraft(empty()); setMissing(null); void operation(() => reloadList()) }}>确认不存在并开始新建</Button></div>}
        {latest && <div role="status"><p>服务器最新草稿 v{latest.source.version}；本地编辑基于 v{detail?.source.version}。</p><Button autoInsertSpace={false} onClick={() => { client.acknowledgeLatest(latest.source.sourceId); setDetail(latest); setDraft(fromDetail(latest)); setLatest(null) }}>采用服务器版本并放弃当前草稿</Button></div>}
        {detail?.published && <section><h3>查询已发布版本 r{detail.published.revision}</h3>
          {draft.kind !== 'http' && <label className="set-field">只读 SQL<Input.TextArea aria-label="只读 SQL" rows={4} spellCheck={false} value={sql} onChange={e => setSql(e.target.value)} /></label>}
          <Button autoInsertSpace={false} disabled={busy || unknown || unresolvedResult || !detail.source.enabled} onClick={() => void operation(async () => {
            if (unresolvedResult) return
            setResultBusy(true); setQueryFailed(false)
            try {
              const query = draft.kind === 'http' ? {} : { sql }
              if (resultsClient) {
                const captured = await resultsClient.query(detail.source.sourceId, query)
                if (alive.current) { setResultPage(0); setCapture(captured); setSavedResult(null); saveIntent.current = null; setResultName(detail.source.name + '查询结果'); setResult({ version: 1, sourceId: captured.artifact.sourceId, sourceVersion: captured.artifact.sourceVersion, schema: captured.schema, timezone: captured.timezone, rows: captured.preview, truncated: captured.sourceTruncated, sha256: captured.sha256 }) }
              } else { const snapshot = await client.query(detail.source.sourceId, query); if (alive.current) { setResultPage(0); setResult(snapshot); setCapture(null) } }
            } catch { if (alive.current) setQueryFailed(true); throw Error('查询未完成，请检查当前工作区的连接授权与连接状态。') }
            finally { if (alive.current) setResultBusy(false) }
          })}>执行已发布查询</Button>
        </section>}
        {result && <section aria-label="查询结果">{queryFailed && <Alert type="warning" showIcon title="本次查询未完成，以下为上一次成功查询的结果；保存或下载仍对应该旧结果。"/>}<p>来源 {result.sourceId} r{result.sourceVersion} · 时区 {result.timezone} · {capture?.totalRows ?? result.rows.length} 行{result.truncated ? '（结果已截断）' : ''}</p><p className="source-hash">SHA-256 {result.sha256}</p>
          {capture && resultsClient && <div className="source-actions"><label>工作区结果名称<Input aria-label="工作区结果名称" value={resultName} disabled={resultBusy || !!saveIntent.current || !!savedResult} maxLength={200} onChange={event => setResultName(event.target.value)} /></label>
            <Button autoInsertSpace={false} disabled={busy || !!savedResult} onClick={() => void operation(async () => {
              const intent = saveIntent.current ?? { resultId: capture.artifact.resultId, name: resultName, commandId: crypto.randomUUID(), unknown: false }
              saveIntent.current = intent; setResultBusy(true)
              try { const artifact = await resultsClient.save(intent.resultId, intent.name, intent.commandId); if (alive.current) { setSavedResult(artifact); setMessage('冻结结果已保存到当前个人工作区，未重新执行查询。') } }
              catch (failure) {
                const status = (failure as {status?: number})?.status
                const stale = (failure as {code?: string})?.code === 'stale_session'
                if (!intent.unknown && !stale && status !== undefined && status >= 400 && status < 500 && status !== 408) {
                  saveIntent.current = null
                  throw Error(status === 404 || status === 410 ? '冻结结果已失效或不可用，请重新执行查询后再保存。' : status === 413 ? '结果超过保存限制，请缩小查询范围后重新执行。' : status === 401 || status === 403 ? '当前会话无权保存此结果，请核对登录状态和授权。' : '保存请求被拒绝，请核对结果名称和查询范围后重试。')
                }
                intent.unknown = true
                throw Error('保存结果未确认，可使用同一保存操作重试，系统不会重新查询。')
              }
              finally { if (alive.current) setResultBusy(false) }
            })}>{savedResult ? '已保存到工作区' : saveIntent.current ? '确认保存结果' : '保存结果到工作区'}</Button>
            {savedResult && <Button autoInsertSpace={false} disabled={busy} onClick={() => void operation(async () => { const json = await resultsClient.download(savedResult.resultId); if (alive.current) offerSourceResultDownload(json, savedResult.resultId) })}>下载冻结结果 JSON</Button>}
            <span>默认每批读取 1,000 行；当前预览已载入 {result.rows.length} 行，每页显示 20 行。{capture.sourceTruncated ? '原查询已截断，保存不会补回未查询行。' : ''}</span>
          </div>}
          <div className="source-results"><Table size="small" pagination={false} scroll={{x:'max-content'}} rowKey="__rowKey" dataSource={result.rows.slice(resultPage*20,(resultPage+1)*20).map((row,index)=>({values:row,__rowKey:String(resultPage*20+index)}))} columns={result.schema.map(column=>({title:column.name+(column.unit ? `（${column.unit}）` : ''),key:column.name,render:(_value:unknown,record:{values:Record<string,unknown>})=>record.values[column.name]===null?'—':String(record.values[column.name]??'')}))}/></div>
          <SettingsListPager page={resultPage} pageSize={20} total={result.rows.length} label="查询结果" disabled={busy} onPageChange={setResultPage}/>
          <p>分页仅浏览当前已返回的 {result.rows.length} 行，不会重新执行查询。</p>
        </section>}
        {message && <Alert type="success" showIcon title={message} role="status"/>}
      </main>
    </div>
  </section></div>
}
