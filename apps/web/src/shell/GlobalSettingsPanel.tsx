import React, {useCallback, useEffect, useId, useRef, useState} from 'react'
import {GLOBAL_SETTING_KINDS} from '../../../../packages/web-contracts/src/settings'
import type {AdminGlobalConfig, AdminGlobalEntry, GlobalConfigCheck, GlobalConfigPatch, GlobalEntryUpsert, GlobalSettingKind} from '../../../../packages/web-contracts/src/settings'
import {GlobalSettingsError, type GlobalSettingsClient} from './global-settings-client'
import './global-settings.css'

const kindLabels: Record<GlobalSettingKind, string> = {chat: '对话', image_generation: '图像生成', image_analysis: '图像分析', video_analysis: '视频分析', web_search: '网页搜索', image_search: '图片搜索', rerank: '重排', http_mcp: 'HTTP MCP'}
type EntryDraft = Omit<AdminGlobalEntry, 'hasKey'>
type DefaultDraft = Partial<Record<GlobalSettingKind, string | null>>
type Confirmation = {kind: 'clear' | 'remove'; id: string} | {kind: 'rotate' | 'discard'} | null
const metadata = ({id, kind, providerId, label, model, baseUrl, enabled}: EntryDraft): EntryDraft => ({id, kind, providerId, label, model, baseUrl, enabled})
const sameEntry = (left: EntryDraft, right: EntryDraft) => (['id', 'kind', 'providerId', 'label', 'model', 'baseUrl', 'enabled'] as const).every(field => left[field] === right[field])
function scrubPassword(input: HTMLInputElement | null) {if (input) {input.value = ''; input.defaultValue = ''; input.removeAttribute('value')}}

function draftPatch(saved: AdminGlobalConfig | null, drafts: Record<string, EntryDraft>, removed: string[], defaults: DefaultDraft, keys: Map<string, string>, clearKeys: string[]): GlobalConfigPatch {
  if (!saved) return {}
  const entries = new Map(saved.entries.map(entry => [entry.id, entry]))
  const patch: GlobalConfigPatch = {}, upserts: GlobalEntryUpsert[] = []
  for (const id of new Set([...Object.keys(drafts), ...keys.keys(), ...clearKeys])) {
    if (removed.includes(id)) continue
    const previous = entries.get(id), next = drafts[id] ?? previous
    if (!next) continue
    const apiKey = keys.get(id), clearKey = clearKeys.includes(id) && previous?.hasKey
    if (!previous || !sameEntry(next, previous) || apiKey?.trim() || clearKey) upserts.push({...metadata(next), ...(apiKey?.trim() ? {apiKey} : {}), ...(clearKey ? {clearKey: true as const} : {})})
  }
  const removes = removed.filter(id => entries.has(id))
  const changedDefaults: DefaultDraft = {}
  for (const kind of GLOBAL_SETTING_KINDS) {
    if (defaults[kind] !== undefined && defaults[kind] !== (saved.defaults[kind] ?? null)) changedDefaults[kind] = defaults[kind]
  }
  if (upserts.length) patch.upserts = upserts
  if (removes.length) patch.removes = removes
  if (Object.keys(changedDefaults).length) patch.defaults = changedDefaults
  return patch
}

/** Draft credentials live only in this mounted component; the client retains only its operation fence. */
export function GlobalSettingsPanel({client, onClose}: {client: GlobalSettingsClient; onClose: () => void}) {
  const api = useRef(client).current, formId = useId(), modelsId = useId()
  const [saved, setSaved] = useState<AdminGlobalConfig | null>(null)
  const [drafts, setDrafts] = useState<Record<string, EntryDraft>>({}), [removed, setRemoved] = useState<string[]>([])
  const [defaults, setDefaults] = useState<DefaultDraft>({}), [clearKeys, setClearKeys] = useState<string[]>([])
  const [selected, setSelected] = useState(''), [filter, setFilter] = useState<GlobalSettingKind | ''>('')
  const [clientState, setClientState] = useState(api.getState), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [needsReload, setNeedsReload] = useState(false), [checked, setChecked] = useState<GlobalConfigCheck | null>(null), [confirmation, setConfirmation] = useState<Confirmation>(null)
  const keys = useRef(new Map<string, string>()), keyInput = useRef<HTMLInputElement>(null)
  const attachKeyInput = useCallback((input: HTMLInputElement | null) => {
    if (keyInput.current !== input) scrubPassword(keyInput.current)
    keyInput.current = input
    if (input) input.value = keys.current.get(input.dataset.configId ?? '') ?? ''
  }, [])
  const [, renderKeys] = useState(0), alive = useRef(false), generation = useRef(0), locked = useRef(false)
  const entries: AdminGlobalEntry[] = saved ? [
    ...saved.entries.filter(entry => !removed.includes(entry.id)).map(entry => ({...entry, ...drafts[entry.id], hasKey: entry.hasKey})),
    ...Object.values(drafts).filter(entry => !saved.entries.some(previous => previous.id === entry.id) && !removed.includes(entry.id)).map(entry => ({...entry, hasKey: false})),
  ] : []
  const filtered = entries.filter(entry => !filter || entry.kind === filter)
  const current = filtered.find(entry => entry.id === selected) ?? filtered[0]
  const provider = current && saved?.providerCatalog.find(item => item.id === current.providerId && item.kinds.includes(current.kind))
  const patch = draftPatch(saved, drafts, removed, defaults, keys.current, clearKeys)
  const dirty = !!(patch.upserts?.length || patch.removes?.length || Object.keys(patch.defaults ?? {}).length)
  const busy = clientState.pending !== null, blocked = busy || clientState.unknownWrite || needsReload || !saved

  const clearSecrets = useCallback(() => {
    keys.current.clear()
    scrubPassword(keyInput.current)
    if (alive.current) renderKeys(version => version + 1)
  }, [])
  const resetDrafts = useCallback(() => {setDrafts({}); setRemoved([]); setDefaults({}); setClearKeys([]); setConfirmation(null); clearSecrets()}, [clearSecrets])
  const report = useCallback((cause: unknown) => {
    const failure = cause instanceof GlobalSettingsError ? cause : new GlobalSettingsError('request_failed')
    setError(failure.message)
    if (failure.code === 'conflict' || failure.code === 'stale_session' || failure.code === 'unauthorized' || failure.code === 'forbidden') setNeedsReload(true)
  }, [])
  const perform = useCallback(async <T,>(work: () => Promise<T>, apply: (result: T) => void) => {
    if (locked.current || api.getState().pending) return
    locked.current = true
    const stamp = generation.current
    setError(''); setNotice(''); setChecked(null)
    try {const result = await work(); if (alive.current && stamp === generation.current) apply(result)}
    catch (cause) {if (alive.current && stamp === generation.current) report(cause)}
    finally {if (stamp === generation.current) locked.current = false}
  }, [api, report])
  const readLatest = useCallback(async (preserve: boolean, explicit: boolean) => {
    if (explicit) clearSecrets()
    await perform(() => api.load(explicit ? {reconcile: true} : undefined), result => {
      setSaved(result); setNeedsReload(false)
      if (!preserve) resetDrafts()
      if (explicit) setNotice(preserve ? `已读取版本 ${result.revision}。非密钥草稿已保留，请核对后再保存；已提交的密钥不会回填。` : `已重新加载版本 ${result.revision}，未保存草稿已放弃。`)
    })
  }, [api, clearSecrets, perform, resetDrafts])
  useEffect(() => {
    alive.current = true; const stamp = ++generation.current; locked.current = false
    const credentials = keys.current
    let initialRequested = false
    const changed = () => {
      if (!alive.current) return
      setClientState(api.getState())
      if (!initialRequested && !api.getState().pending) {initialRequested = true; void readLatest(false, false)}
    }
    const unsubscribe = api.subscribe(changed)
    changed()
    return () => {alive.current = false; generation.current = stamp + 1; locked.current = false; credentials.clear(); unsubscribe()}
  }, [api, readLatest])

  function update(entry: AdminGlobalEntry, change: Partial<EntryDraft>) {
    const nextEntry = {...metadata(entry), ...change}
    setDrafts(previous => ({...previous, [entry.id]: nextEntry}))
    if (change.kind !== undefined || change.enabled === false) setDefaults(previous => {
      const next = {...previous}
      for (const kind of GLOBAL_SETTING_KINDS) {
        const selectedId = previous[kind] === undefined ? saved?.defaults[kind] : previous[kind]
        if (selectedId === entry.id && (!nextEntry.enabled || nextEntry.kind !== kind)) next[kind] = null
      }
      return next
    })
    setNotice('')
  }
  function add() {
    if (!saved) return
    const kind = filter || 'chat', first = saved.providerCatalog.find(item => item.available && item.kinds.includes(kind))
    const id = crypto.randomUUID()
    setDrafts(previous => ({...previous, [id]: {id, kind, providerId: first?.id ?? '', label: first ? `${first.label} 新配置` : '新配置', model: first?.models[0] ?? '', baseUrl: first?.defaultBaseUrl ?? '', enabled: false}}))
    setSelected(id); setNotice(''); setConfirmation(null)
  }
  async function save() {
    if (blocked || !dirty || locked.current || !saved) return
    const outgoing = draftPatch(saved, drafts, removed, defaults, keys.current, clearKeys)
    clearSecrets()
    await perform(() => api.save(saved.revision, outgoing), result => {setSaved(result); resetDrafts(); setNotice(`配置已保存，当前版本 ${result.revision}。`)})
  }
  async function check() {
    if (blocked || !saved) return
    await perform(() => api.check(saved.revision), setChecked)
  }
  async function rotate() {
    if (blocked || !saved) return
    setConfirmation(null)
    await perform(() => api.rotate(saved.revision), result => {setSaved(result); setNotice(`已使用服务器当前活动密钥重新加密，当前版本 ${result.revision}。未保存的非密钥草稿已保留。`)})
  }
  function confirmEntry(kind: 'clear' | 'remove', id: string) {
    keys.current.delete(id)
    scrubPassword(keyInput.current)
    renderKeys(version => version + 1)
    if (kind === 'clear') setClearKeys(previous => [...new Set([...previous, id])])
    else {
      setRemoved(previous => [...new Set([...previous, id])])
      setDefaults(previous => {
        const next = {...previous}
        for (const item of GLOBAL_SETTING_KINDS) if ((previous[item] ?? saved?.defaults[item]) === id) next[item] = null
        return next
      })
    }
    setConfirmation(null); setNotice('')
  }
  function close() {clearSecrets(); onClose()}

  return <section className="set-pane global-settings-panel" aria-label="全局配置" onKeyDown={event => {if (event.key === 'Escape') {event.stopPropagation(); if (confirmation) setConfirmation(null); else close()}}}>
    <div className="set-pane-head global-settings-heading"><div><h3 className="set-pane-title">全局配置</h3><p className="set-field-desc">{saved ? `已保存版本 ${saved.revision}${dirty ? ' · 有未保存更改' : ''}` : '正在读取配置'}</p></div><button className="set-close" type="button" aria-label="关闭全局配置" onClick={close}>×</button></div>
    <p className="set-field-desc">由配置管理员管理服务商、模型和默认选项，供当前部署中的用户使用。个人偏好在个人设置中管理。</p>
    <div className="set-btn-row global-settings-toolbar">
      <button className="set-btn primary" type="submit" form={formId} disabled={blocked || !dirty}>保存配置</button>
      <button className="set-btn" type="button" disabled={busy} onClick={() => void readLatest(true, true)}>读取最新配置</button>
      <button className="set-btn" type="button" disabled={busy || !dirty} onClick={() => setConfirmation({kind: 'discard'})}>放弃草稿并重新加载</button>
      <button className="set-btn" type="button" disabled={blocked} onClick={() => void check()}>检查已保存配置</button>
    </div>
    {busy && <p className="set-field-desc" aria-live="polite">{clientState.pending === 'load' ? '正在读取配置…' : '配置操作正在进行中…'}</p>}
    {clientState.unknownWrite && <p className="global-settings-alert" role="alert">无法确认上次写入结果。请读取最新配置并核对；关闭面板后此保护仍然有效，系统不会自动重复提交。</p>}
    {error && <p className="global-settings-alert" role="alert">{error}</p>}
    {notice && <p className="global-settings-result" role="status">{notice}</p>}
    {checked && <p className="global-settings-result" role="status">版本 {checked.revision} 的已保存配置有效，共检查 {checked.checkedEntries} 个条目。{checked.secrets === 'readable' ? '已保存密钥可解密。' : '本次检查无需读取密钥。'}未进行模型或服务连通测试。</p>}
    {saved && !saved.keyStorageAvailable && <p className="global-settings-alert">服务器尚未配置可用的密钥存储。可以修改非密钥配置；保存新密钥和重新加密暂不可用。</p>}
    {confirmation && <div className="global-settings-confirm" role="alertdialog" aria-label="确认配置操作">
      {confirmation.kind === 'clear' ? <><h4>清空已保存密钥？</h4><p>保存配置后，将删除「{entries.find(entry => entry.id === confirmation.id)?.label}」的密钥。留空输入框会保留原密钥，只有此操作才会清空。</p><button className="set-btn danger" type="button" disabled={busy} onClick={() => confirmEntry('clear', confirmation.id)}>确认清空密钥</button></>
        : confirmation.kind === 'remove' ? <><h4>删除配置？</h4><p>保存后将删除「{entries.find(entry => entry.id === confirmation.id)?.label}」及其密钥，并取消引用此条目的默认选项。</p><button className="set-btn danger" type="button" disabled={busy} onClick={() => confirmEntry('remove', confirmation.id)}>确认删除配置</button></>
        : confirmation.kind === 'rotate' ? <><h4>重新加密已保存密钥？</h4><p>使用服务器已配置的当前活动密钥重新加密全部已保存密钥。此操作不会更换服务商的 API 密钥，也不会保存表单草稿。</p><button className="set-btn primary" type="button" disabled={blocked} onClick={() => void rotate()}>确认重新加密</button></>
        : <><h4>放弃未保存草稿？</h4><p>将读取最新配置；成功后放弃本面板中的未保存更改。</p><button className="set-btn danger" type="button" disabled={busy} onClick={() => void readLatest(false, true)}>确认放弃草稿</button></>}
      <button className="set-btn" type="button" disabled={busy} onClick={() => setConfirmation(null)}>取消</button>
    </div>}
    {saved && <form id={formId} aria-label="全局配置表单" onSubmit={event => {event.preventDefault(); void save()}}>
      <div className="global-settings-grid">
        <aside className="global-settings-list" aria-label="配置列表">
          <div className="global-settings-list-head"><h4>服务配置</h4><button className="set-btn" type="button" disabled={busy || entries.length >= 100} onClick={add}>添加配置</button></div>
          <label className="global-settings-filter">配置类型筛选<select aria-label="配置类型筛选" className="global-settings-select" value={filter} disabled={busy} onChange={event => {setFilter(event.target.value as GlobalSettingKind | ''); setConfirmation(null)}}><option value="">全部类型</option>{GLOBAL_SETTING_KINDS.map(kind => <option key={kind} value={kind}>{kindLabels[kind]}</option>)}</select></label>
          <ul>{filtered.map(entry => <li key={entry.id}><button type="button" className={`global-settings-entry${current?.id === entry.id ? ' active' : ''}`} aria-pressed={current?.id === entry.id} disabled={busy} onClick={() => {setSelected(entry.id); setConfirmation(null)}}><strong>{entry.label || '未命名配置'}</strong><span>{kindLabels[entry.kind]} · {entry.enabled ? '已启用' : '已停用'}{saved.defaults[entry.kind] === entry.id ? ' · 已保存默认' : ''}</span></button></li>)}</ul>
          {!filtered.length && <p className="set-field-desc">暂无配置。添加一个服务配置以开始设置。</p>}
          {removed.length > 0 && <p className="set-field-desc">{removed.length} 个条目待删除，保存后生效。</p>}
        </aside>
        <div className="global-settings-editor">
          {current ? <fieldset disabled={busy}>
            <legend>编辑配置</legend>
            <label className="global-settings-field"><span>配置名称</span><input className="set-input" aria-label="配置名称" value={current.label} maxLength={200} required onChange={event => update(current, {label: event.target.value})}/></label>
            <label className="global-settings-field"><span>配置类型</span><select className="global-settings-select" aria-label="配置类型" value={current.kind} onChange={event => {const kind = event.target.value as GlobalSettingKind; const first = saved.providerCatalog.find(item => item.available && item.kinds.includes(kind)); update(current, {kind, providerId: first?.id ?? '', model: first?.models[0] ?? '', baseUrl: first?.defaultBaseUrl ?? ''}); if (filter) setFilter(kind)}}>{GLOBAL_SETTING_KINDS.map(kind => <option key={kind} value={kind}>{kindLabels[kind]}</option>)}</select></label>
            <label className="global-settings-field"><span>服务商</span><select className="global-settings-select" aria-label="服务商" value={current.providerId} required onChange={event => {const next = saved.providerCatalog.find(item => item.id === event.target.value && item.kinds.includes(current.kind)); if (next) update(current, {providerId: next.id, model: next.models[0] ?? '', baseUrl: next.defaultBaseUrl})}}>{!provider && <option value="">请选择可用服务商</option>}{saved.providerCatalog.filter(item => item.kinds.includes(current.kind)).map(item => <option key={item.id} value={item.id} disabled={!item.available}>{item.label}{!item.available ? '（当前 Web 不可用）' : ''}</option>)}</select></label>
            {provider?.available === false && <p className="set-field-desc">{provider.unavailableReason || '此服务商在当前 Web 环境中不可用。'}</p>}
            <label className="global-settings-field"><span>模型标识</span><input className="set-input" aria-label="模型标识" value={current.model} maxLength={256} list={modelsId} required={!['web_search', 'image_search', 'http_mcp'].includes(current.kind)} onChange={event => update(current, {model: event.target.value})}/><datalist id={modelsId}>{provider?.models.map(model => <option key={model} value={model}>{model}</option>)}</datalist></label>
            <label className="global-settings-field"><span>服务地址</span><input className="set-input" aria-label="服务地址" type="url" value={current.baseUrl} maxLength={2048} placeholder="https://api.example.com/v1" required={current.enabled} onChange={event => update(current, {baseUrl: event.target.value})}/></label>
            <p className="set-field-desc">使用 HTTP 或 HTTPS 地址。凭据请填写在密钥输入框中，地址中不要包含账号、密码、查询参数或片段。</p>
            <label className="global-settings-toggle"><input type="checkbox" aria-label="启用配置" checked={current.enabled} onChange={event => update(current, {enabled: event.target.checked})}/>启用配置</label>
            <div className="global-settings-key"><h4>API 密钥</h4><p className="set-field-desc">{current.hasKey ? '已保存密钥' : '未保存密钥'}{clearKeys.includes(current.id) ? ' · 待清空，保存后生效' : ''}。密钥不会回填；留空会保留已保存密钥。未提交的密钥只保留在本面板中，关闭或刷新后丢弃。</p>
              <label className="global-settings-field"><span>替换密钥</span><input ref={attachKeyInput} data-config-id={current.id} className="set-input" aria-label="API 密钥" type="password" autoComplete="new-password" spellCheck={false} value={keys.current.get(current.id) ?? ''} disabled={!saved.keyStorageAvailable || clearKeys.includes(current.id)} placeholder={current.hasKey ? '留空保留已保存密钥' : '输入新的 API 密钥'} onChange={event => {keys.current.set(current.id, event.target.value); renderKeys(version => version + 1)}}/></label>
              {current.hasKey && <div className="set-btn-row">{clearKeys.includes(current.id) ? <button className="set-btn" type="button" onClick={() => setClearKeys(previous => previous.filter(id => id !== current.id))}>取消清空密钥</button> : <button className="set-btn danger" type="button" onClick={() => setConfirmation({kind: 'clear', id: current.id})}>清空密钥</button>}</div>}
              {current.hasKey && <p className="set-field-desc">更换配置类型或服务商时，需要同时替换或明确清空原密钥。</p>}
            </div>
            <div className="set-btn-row"><button className="set-btn danger" type="button" onClick={() => setConfirmation({kind: 'remove', id: current.id})}>删除配置</button></div>
          </fieldset> : <p className="set-field-desc">选择或添加配置后可编辑服务商、模型和密钥。</p>}
        </div>
      </div>
      <section className="global-settings-defaults" aria-label="默认配置"><h4>默认配置</h4><p className="set-field-desc">只能选择已启用的条目。停用或删除默认条目后，相应默认选项会被取消。</p><div className="global-settings-default-grid">{GLOBAL_SETTING_KINDS.map(kind => {
        const available = entries.filter(entry => entry.enabled && entry.kind === kind)
        const wanted = defaults[kind] === undefined ? saved.defaults[kind] : defaults[kind]
        const value = available.some(entry => entry.id === wanted) ? wanted ?? '' : ''
        return <label className="global-settings-field" key={kind}><span>{kindLabels[kind]}</span><select className="global-settings-select" aria-label={`默认${kindLabels[kind]}配置`} value={value} disabled={busy} onChange={event => setDefaults(previous => ({...previous, [kind]: event.target.value || null}))}><option value="">未指定默认</option>{available.map(entry => <option key={entry.id} value={entry.id}>{entry.label}</option>)}</select></label>
      })}</div></section>
    </form>}
    {saved && <><details className="global-settings-latest"><summary>查看服务器当前配置（版本 {saved.revision}）</summary><ul>{saved.entries.map(entry => <li key={entry.id}><strong>{entry.label}</strong> · {kindLabels[entry.kind]} · {entry.providerId} · {entry.model || '未指定模型'} · {entry.enabled ? '已启用' : '已停用'} · {entry.hasKey ? '已保存密钥' : '未保存密钥'}<span>{entry.baseUrl}</span></li>)}</ul>{!saved.entries.length && <p>尚无已保存配置。</p>}</details>
      <section className="global-settings-maintenance"><div><h4>密钥维护</h4><p className="set-field-desc">服务器活动加密密钥更新后，可重新加密已保存的 API 密钥。</p></div><button className="set-btn" type="button" disabled={blocked || !saved.keyStorageAvailable} onClick={() => setConfirmation({kind: 'rotate'})}>轮换加密密钥</button></section></>}
  </section>
}

