import React, {useCallback, useEffect, useId, useRef, useState, type ReactNode} from 'react'
import {DEFAULT_OFFICE_EMBED_ORIGINS, GLOBAL_SETTING_KINDS} from '../../../../packages/web-contracts/src/settings'
import type {AdminGlobalConfig, AdminGlobalEntry, GlobalConfigCheck, GlobalConfigPatch, GlobalEntryUpsert, GlobalSettingKind, ModelConnectionFailure, SourceEgressTarget} from '../../../../packages/web-contracts/src/settings'
import {GlobalSettingsError, type GlobalSettingsClient} from './global-settings-client'
import './global-settings.css'
import {NativeSettingsPager} from './NativeSettingsPager'
import {SourceEgressSettings} from './SourceEgressSettings'
import './global-settings-native.css'

function ConfigSelect<T extends string>({options,value,onChange,placeholder,...props}: {options:readonly {value:T;label:string;disabled?:boolean;hidden?:boolean}[];value?:T;onChange:(value:T)=>void;placeholder?:string;disabled?:boolean;className?:string;'aria-label':string}) {
  return <select {...props} value={value??''} onChange={event=>onChange(event.target.value as T)}>{placeholder&&<option value="" disabled>{placeholder}</option>}{options.map(option=><option value={option.value} disabled={option.disabled} hidden={option.hidden} key={option.value}>{option.label}</option>)}</select>
}
function NativeNotice({type,title,action,role}: {type:'error'|'warning'|'success'|'info';title:ReactNode;action?:ReactNode;role?:'status';showIcon?:boolean}) {
  return <div className={`global-native-notice global-native-notice--${type}`} role={role??(type==='error'||type==='warning'?'alert':'status')}><span>{title}</span>{action}</div>
}
function StatusBadge({color,children}: {color:string;children:ReactNode}) {return <span className="global-native-badge" data-tone={color}>{children}</span>}
function ConfigIcon({kind}: {kind:'model'|'picture'|'lock'|'link'|'plus'}) {
  const paths={model:'M4 4h16v12H8l-4 4V4Zm4 4h8M8 12h5',picture:'M4 4h16v16H4V4Zm0 12 5-5 4 4 3-3 4 4M14 8h.01',lock:'M6 10h12v10H6V10Zm3 0V7a3 3 0 0 1 6 0v3',link:'m10 13 4-4M8 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 1 1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0',plus:'M12 5v14M5 12h14'}
  return <svg className="global-native-icon" aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d={paths[kind]}/></svg>
}

const kindLabels: Record<GlobalSettingKind, string> = {chat: '对话', image_generation: '图像生成', image_analysis: '图像分析', video_analysis: '视频分析', web_search: '网页搜索', image_search: '图片搜索', rerank: '重排', http_mcp: 'HTTP MCP'}
const modelConnectionGuidance: Record<ModelConnectionFailure,string> = {
  PROVIDER_AUTH_REJECTED: '供应商拒绝了请求，请检查 API 密钥和模型访问权限。',
  PROVIDER_RATE_LIMITED: '供应商限流或额度不足，请检查供应商额度，或稍后重试。',
  PROVIDER_TEMPORARILY_UNAVAILABLE: '供应商服务暂时不可用，请稍后重试。',
}
type ConfigGroup = 'ai' | 'media' | 'sources' | 'embed'
const groupFor = (kind: GlobalSettingKind): ConfigGroup => kind === 'chat' ? 'ai' : 'media'
const mediaKinds: GlobalSettingKind[] = ['image_generation', 'image_analysis', 'video_analysis', 'web_search', 'image_search']
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
export function GlobalSettingsPanel({client, onClose, presentation = 'dialog', onCloseGuardChange}: {client: GlobalSettingsClient; onClose: () => void; presentation?: 'dialog' | 'page'; onCloseGuardChange?: (guard: (() => boolean) | null) => void}) {
  const api = useRef(client).current, formId = useId(), modelsId = useId()
  const [saved, setSaved] = useState<AdminGlobalConfig | null>(null)
  const [serverPage, setServerPage] = useState(0)
  const serverLastPage = Math.max(0, Math.ceil((saved?.entries.length ?? 0) / 10) - 1)
  const currentServerPage = Math.min(serverPage, serverLastPage)
  useEffect(() => {setServerPage(page => Math.min(page, serverLastPage))}, [serverLastPage])
  const [drafts, setDrafts] = useState<Record<string, EntryDraft>>({}), [removed, setRemoved] = useState<string[]>([])
  const [defaults, setDefaults] = useState<DefaultDraft>({}), [clearKeys, setClearKeys] = useState<string[]>([])
  const [group, setGroup] = useState<ConfigGroup>('ai')
  const [sourceTargets, setSourceTargets] = useState<SourceEgressTarget[] | null>(null)
  const [embedOrigins, setEmbedOrigins] = useState<string | null>(null)
  const embedOpen = group === 'embed'
  const sourcesOpen = group === 'sources'
  const [configSearch,setConfigSearch]=useState('')
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
  const groupKinds = group === 'ai' ? ['chat'] as GlobalSettingKind[] : [...mediaKinds, ...GLOBAL_SETTING_KINDS.filter(kind => !mediaKinds.includes(kind) && kind !== 'chat' && entries.some(entry => entry.kind === kind))]
  const filtered = entries.filter(entry => groupKinds.includes(entry.kind) && (!filter || entry.kind === filter))
  const current = (sourcesOpen || embedOpen) ? undefined : (filtered.find(entry => entry.id === selected) ?? filtered[0])
  const provider = current && saved?.providerCatalog.find(item => item.id === current.providerId && item.kinds.includes(current.kind))
  const patch = draftPatch(saved, drafts, removed, defaults, keys.current, clearKeys)
  const dirty = !!(patch.upserts?.length || patch.removes?.length || Object.keys(patch.defaults ?? {}).length || sourceTargets || embedOrigins !== null)
  const busy = clientState.pending !== null, blocked = busy || clientState.unknownWrite || needsReload || !saved
  useEffect(() => {
    if (!dirty && !clientState.unknownWrite && (!busy || clientState.pending === 'load')) return
    const prevent = (event: BeforeUnloadEvent) => {event.preventDefault(); event.returnValue = ''}
    window.addEventListener('beforeunload', prevent)
    return () => window.removeEventListener('beforeunload', prevent)
  }, [dirty, clientState.unknownWrite, busy, clientState.pending])

  const clearSecrets = useCallback(() => {
    keys.current.clear()
    scrubPassword(keyInput.current)
    if (alive.current) renderKeys(version => version + 1)
  }, [])
  const resetDrafts = useCallback(() => {setDrafts({}); setRemoved([]); setDefaults({}); setClearKeys([]); setSourceTargets(null); setEmbedOrigins(null); setConfirmation(null); clearSecrets()}, [clearSecrets])
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
      if (explicit) setNotice(preserve ? '已读取最新配置。非密钥草稿已保留，请核对后再保存；已提交的密钥不会回填。' : '已重新加载配置，未保存草稿已放弃。')
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
  function add(kind: GlobalSettingKind = filter || (group === 'ai' ? 'chat' : 'image_generation')) {
    if (!saved) return
    const first = saved.providerCatalog.find(item => item.available && item.kinds.includes(kind))
    const id = crypto.randomUUID()
    setDrafts(previous => ({...previous, [id]: {id, kind, providerId: first?.id ?? '', label: first ? `${first.label} 新配置` : '新配置', model: first?.models[0] ?? '', baseUrl: first?.defaultBaseUrl ?? '', enabled: false}}))
    setSelected(id); setConfigSearch(''); setNotice(''); setConfirmation(null)
  }
  async function save() {
    if (blocked || !dirty || locked.current || !saved) return
    const outgoing = draftPatch(saved, drafts, removed, defaults, keys.current, clearKeys)
    if (sourceTargets) outgoing.sourceEgressTargets = sourceTargets.map(({kind, endpoint, addresses, username, database, allowInsecure, allowPrivilegedAccount, ca}) => ({
      kind, endpoint: endpoint.trim(), addresses: addresses.map(ip => ip.trim()).filter(Boolean),
      ...(kind === 'http' ? {} : {username: username?.trim(), database: database?.trim()}),
      ...(allowInsecure !== undefined ? {allowInsecure} : {}), ...(allowPrivilegedAccount !== undefined ? {allowPrivilegedAccount} : {}), ...(!allowInsecure && ca?.trim() ? {ca: ca.trim()} : {}),
    }))
    if (embedOrigins !== null) outgoing.officeEmbedOrigins = embedOrigins.split(/\r?\n/).map(value => value.trim()).filter(Boolean)
    clearSecrets()
    await perform(() => api.save(saved.revision, outgoing), result => {setSaved(result); resetDrafts(); setNotice('配置已保存。')})
  }
  async function check() {
    if (blocked || !saved) return
    await perform(() => api.check(saved.revision), setChecked)
  }
  async function rotate() {
    if (blocked || !saved) return
    setConfirmation(null)
    await perform(() => api.rotate(saved.revision), result => {setSaved(result); setNotice('已重新加密保存的密钥。未保存的非密钥草稿已保留。')})
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
  const closeState = useRef({busy: false, dirty: false, unknown: false})
  closeState.current = {busy: busy && clientState.pending !== 'load', dirty, unknown: clientState.unknownWrite}
  const canClose = useCallback(() => {
    const state = closeState.current
    const pending = api.getState().pending
    if (state.busy || (pending !== null && pending !== 'load')) return false
    if (state.unknown) return window.confirm('上次配置写入结果尚未确认。关闭后仍需读取最新配置核对，系统不会自动重试。是否关闭？')
    if (state.dirty) return window.confirm('全局配置有未保存更改，关闭将放弃草稿和未提交的密钥。是否关闭？')
    return true
  }, [api])
  useEffect(() => {onCloseGuardChange?.(canClose); return () => onCloseGuardChange?.(null)}, [canClose, onCloseGuardChange])
  function close() {if (canClose()) {clearSecrets(); onClose()}}

  return <section className={`set-pane global-settings-panel global-settings-refined${presentation === 'page' ? ' global-settings-page' : ''}`} aria-label="全局配置" onKeyDown={event => {if (event.key === 'Escape') {event.stopPropagation(); if (confirmation) setConfirmation(null); else if (presentation === 'dialog') close()}}}>
    {presentation === 'dialog' && <div className="global-settings-heading"><h3>全局配置</h3><button type="button" data-variant="text" aria-label="关闭全局配置" onClick={close}>×</button></div>}
    <div className="global-settings-layout">
      <aside className="global-settings-navigation">
        <span className="global-settings-nav-caption">平台设置</span>
        <nav className="global-settings-groups" role="tablist" aria-label="全局配置分类">{([{key:'ai',label:'AI 模型',icon:'model'},{key:'media',label:'生图、媒体与搜索',icon:'picture'},{key:'sources',label:'数据源白名单',icon:'link'},{key:'embed',label:'跨域嵌入',icon:'link'}] as const).map(item=><button type="button" role="tab" aria-selected={group===item.key} disabled={busy} key={item.key} onClick={()=>{setGroup(item.key);setFilter('');setSelected('');setConfigSearch('');setConfirmation(null)}}><ConfigIcon kind={item.icon}/>{item.label}</button>)}</nav>
      </aside>
      <div className="global-settings-content">
        <header className="global-settings-content-head">
          <div><h2>{embedOpen ? '跨域嵌入' : sourcesOpen ? '数据源白名单' : group === 'ai' ? 'AI 模型' : '生图、媒体与搜索'}</h2>{!sourcesOpen && !embedOpen && <p className="global-settings-intro">{group === 'ai' ? '为文档、表格、演示和 PDF 的 AI 助手配置共享模型。' : '为团队配置生图、媒体解析及搜索服务。'}</p>}</div>
          <div className="global-settings-primary-actions">
            {dirty && <button type="button" disabled={blocked} onClick={() => setConfirmation({kind: 'discard'})}>放弃更改</button>}
            {current?.kind === 'chat' && <button type="button" disabled={blocked || dirty || !current.enabled || !current.hasKey} title={dirty ? '请先保存，再测试连接。' : '使用已保存的模型发送简短测试消息'} onClick={() => void perform(() => api.testConnection(current.id), result => {
              if (result.ok) setNotice('模型连接成功，已验证共享模型调用。')
              else setError(result.reason ? modelConnectionGuidance[result.reason] : '模型连接失败，请检查 API 密钥、模型名称和接口地址。')
            })}><ConfigIcon kind="link"/>测试连接</button>}
            <button type="submit" data-variant="primary" form={formId} aria-busy={clientState.pending === 'save'} disabled={blocked || !dirty}>保存配置</button>
          </div>
        </header>
        <div className="global-settings-status" aria-label="配置状态摘要">
          <span className={`global-settings-save-state${dirty ? ' is-dirty' : ''}`}>{clientState.unknownWrite ? '写入结果待核对' : needsReload ? '需要读取最新配置' : dirty ? '有未保存更改' : saved ? '已保存配置' : '正在读取配置'}</span>
          {embedOpen ? <span>保存后生效</span> : sourcesOpen ? saved && <span>{(saved.sourceEgressTargets ?? []).some(target => target.kind !== 'http') ? '数据库白名单已启用' : '数据库目标不受白名单限制'}</span> : <span>服务配置 {saved ? entries.length : '—'} · 已启用 {saved ? entries.filter(entry => entry.enabled).length : '—'}</span>}
          {dirty && current?.kind === 'chat' && <span>请先保存，再测试连接。</span>}
        </div>
        {busy && <p className="set-field-desc" aria-live="polite">{clientState.pending === 'load' ? '正在读取配置…' : '正在处理…'}</p>}
        {clientState.unknownWrite && <NativeNotice type="warning" showIcon title="无法确认上次写入结果。请读取最新配置并核对，系统不会自动重复提交。" action={<button type="button" disabled={busy} onClick={() => void readLatest(true, true)}>读取最新配置</button>}/>}
        {error && <NativeNotice type="error" showIcon title={error} action={!saved ? <button type="button" disabled={busy} onClick={() => void readLatest(false, true)}>重新读取</button> : needsReload && !clientState.unknownWrite ? <button type="button" disabled={busy} onClick={() => void readLatest(true, true)}>读取最新配置</button> : undefined}/> }
        {notice && <NativeNotice type="success" role="status" showIcon title={notice}/>}
        {checked && <NativeNotice type="info" role="status" title={`已保存配置有效，共检查 ${checked.checkedEntries} 个条目。${checked.secrets === 'readable' ? '已保存密钥可解密。' : ''}未进行模型或服务连通测试。`}/>}
        {saved && !saved.keyStorageAvailable && <NativeNotice type="warning" title="服务器尚未配置密钥存储，暂时无法保存新的 API 密钥。"/>}
        {confirmation && <div className="global-settings-confirm" role="alertdialog" aria-label="确认配置操作">
          {confirmation.kind === 'clear' ? <><h4>清空已保存密钥？</h4><p>保存配置后，将删除「{entries.find(entry => entry.id === confirmation.id)?.label}」的密钥。</p><button type="button" data-variant="danger" disabled={busy} onClick={() => confirmEntry('clear', confirmation.id)}>确认清空密钥</button></>
            : confirmation.kind === 'remove' ? <><h4>删除配置？</h4><p>保存后将删除「{entries.find(entry => entry.id === confirmation.id)?.label}」及其密钥，并取消对应默认选项。</p><button type="button" data-variant="danger" disabled={busy} onClick={() => confirmEntry('remove', confirmation.id)}>确认删除配置</button></>
            : confirmation.kind === 'rotate' ? <><h4>重新加密已保存密钥？</h4><p>使用服务器当前活动密钥重新加密，不会更换服务商 API Key，也不会保存草稿。</p><button type="button" data-variant="primary" disabled={blocked} onClick={() => void rotate()}>确认重新加密</button></>
            : <><h4>放弃未保存草稿？</h4><p>重新加载配置，放弃本面板的未保存更改。</p><button type="button" data-variant="danger" disabled={busy} onClick={() => void readLatest(false, true)}>确认放弃草稿</button></>}
          <button type="button" disabled={busy} onClick={() => setConfirmation(null)}>取消</button>
        </div>}
        {saved && <form id={formId} aria-label="全局配置表单" onSubmit={event => {event.preventDefault(); void save()}}>
          {embedOpen ? <div>
            <p className="global-settings-intro">允许以下应用来源嵌入 Office 网页。每行填写一个 http:// 或 https:// 地址（含端口，不含路径）。留空关闭跨域嵌入。</p>
            <label className="global-settings-field"><span>允许的来源</span><textarea aria-label="Office 跨域嵌入来源" rows={7} disabled={blocked} value={embedOrigins ?? (saved.officeEmbedOrigins ?? [...DEFAULT_OFFICE_EMBED_ORIGINS]).join('\n')} onChange={event => setEmbedOrigins(event.target.value)}/></label>
            <button type="button" disabled={blocked} onClick={() => setEmbedOrigins(DEFAULT_OFFICE_EMBED_ORIGINS.join('\n'))}>恢复本地回环地址</button>
          </div> : sourcesOpen ? <SourceEgressSettings targets={sourceTargets ?? saved.sourceEgressTargets ?? []} onChange={setSourceTargets} disabled={blocked}/> : <>
          <div className="global-settings-config-picker">
            {group === 'media' && <ConfigSelect aria-label="配置类型筛选" value={filter} disabled={busy} onChange={value => {setFilter(value); setSelected(''); setConfirmation(null)}} options={[{value: '', label: '全部服务'}, ...groupKinds.map(kind => ({value: kind, label: kindLabels[kind]}))]}/>}
            <div className="global-settings-choice"><input type="search" aria-label="搜索服务配置" placeholder="搜索服务配置" value={configSearch} disabled={busy} onChange={event=>setConfigSearch(event.target.value)}/><ConfigSelect className="global-settings-config-select" aria-label="选择服务配置" value={current?.id} placeholder="选择服务配置" disabled={busy || !filtered.length} onChange={value => {setSelected(value); setConfirmation(null)}} options={filtered.filter(entry=>entry.label.toLocaleLowerCase().includes(configSearch.trim().toLocaleLowerCase())||entry.id===current?.id).map(entry => ({value: entry.id, label: `${entry.label || '未命名配置'}${entry.enabled ? '' : ' · 已停用'}`, hidden:!entry.label.toLocaleLowerCase().includes(configSearch.trim().toLocaleLowerCase())}))}/>{configSearch&&!filtered.some(entry=>entry.label.toLocaleLowerCase().includes(configSearch.trim().toLocaleLowerCase()))&&<span role="status">没有匹配的配置</span>}</div>
            <button type="button" data-variant="text" disabled={busy || entries.length >= 100} onClick={() => add()}><ConfigIcon kind="plus"/>添加配置</button>
          </div>
          {current ? <div className="global-settings-editor"><div className="global-settings-current-status" aria-label="当前配置状态"><strong>{current.label || '未命名配置'}</strong><StatusBadge color={current.enabled ? 'green' : 'default'}>{current.enabled ? '已启用' : '已停用'}</StatusBadge><StatusBadge color={clearKeys.includes(current.id) ? 'warning' : keys.current.get(current.id)?.trim() ? 'processing' : current.hasKey ? 'green' : 'default'}>{clearKeys.includes(current.id) ? '密钥待清空' : keys.current.get(current.id)?.trim() ? '新密钥待保存' : current.hasKey ? '密钥已保存' : '尚未配置密钥'}</StatusBadge></div>
            {current.enabled && (!current.hasKey || clearKeys.includes(current.id)) && !keys.current.get(current.id)?.trim() && <NativeNotice type="warning" showIcon title="此配置已启用，但尚无可用密钥。请填写 API Key 并保存后使用。"/>}
            <fieldset disabled={busy}>
            <label className="global-settings-field"><span>模型服务商<small>选择提供此服务的平台</small></span><ConfigSelect aria-label="服务商" value={current.providerId || undefined} placeholder="选择服务商" disabled={busy} onChange={value => {const next = saved.providerCatalog.find(item => item.id === value && item.kinds.includes(current.kind)); if (next) update(current, {providerId: next.id, model: next.models[0] ?? '', baseUrl: next.defaultBaseUrl})}} options={saved.providerCatalog.filter(item => item.kinds.includes(current.kind)).map(item => ({value: item.id, label: `${item.label}${!item.available ? '（当前 Web 不可用）' : ''}`, disabled: !item.available}))}/></label>
            {provider?.available === false && <NativeNotice type="warning" title={provider.unavailableReason || '此服务商在 Web 中不可用。'}/>}
            <label className="global-settings-field"><span>模型<small>可选择推荐模型或输入模型 ID</small></span><div><input disabled={busy} aria-label="模型标识" value={current.model} maxLength={256} list={modelsId} placeholder="输入模型 ID" required={!['web_search', 'image_search', 'http_mcp'].includes(current.kind)} onChange={event => update(current, {model: event.target.value})}/><datalist id={modelsId}>{provider?.models.map(model => <option key={model} value={model}>{model}</option>)}</datalist></div></label>
            <div className="global-settings-field global-settings-key"><label htmlFor={`${formId}-key`}>API Key<small>{clearKeys.includes(current.id) ? '待清空，保存后生效' : current.hasKey ? '已保存密钥，留空保留' : '未保存密钥'}</small></label><div><input type="password" id={`${formId}-key`} ref={attachKeyInput} data-config-id={current.id} aria-label="API 密钥" autoComplete="new-password" spellCheck={false} value={keys.current.get(current.id) ?? ''} disabled={busy || !saved.keyStorageAvailable || clearKeys.includes(current.id)} placeholder={current.hasKey ? '填写新密钥以替换' : '输入服务商 API Key'} onChange={event => {keys.current.set(current.id, event.target.value); renderKeys(version => version + 1)}}/><p className="global-settings-secure-hint"><ConfigIcon kind="lock"/>服务端加密保存，不会回传浏览器。</p></div></div>
            <label className="global-settings-field"><span>Base URL<small>服务商的 HTTPS API 地址</small></span><input disabled={busy} aria-label="服务地址" type="url" value={current.baseUrl} maxLength={2048} placeholder="https://api.example.com/v1" required={current.enabled} onChange={event => update(current, {baseUrl: event.target.value})}/></label>
            <div className="global-settings-field"><span>启用此配置<small>启用后，已授权用户即可使用</small></span><label className="global-native-checkbox"><input type="checkbox" aria-label="启用配置" checked={current.enabled} disabled={busy} onChange={event => update(current, {enabled: event.target.checked})}/>启用</label></div>
            <details className="global-settings-advanced"><summary>更多设置<span>名称、用途与默认配置</span></summary>
              <label className="global-settings-field"><span>配置名称</span><input disabled={busy} aria-label="配置名称" value={current.label} maxLength={200} required onChange={event => update(current, {label: event.target.value})}/></label>
              <label className="global-settings-field"><span>配置类型</span><ConfigSelect aria-label="配置类型" value={current.kind} disabled={busy} onChange={kind => {const first = saved.providerCatalog.find(item => item.available && item.kinds.includes(kind)); update(current, {kind, providerId: first?.id ?? '', model: first?.models[0] ?? '', baseUrl: first?.defaultBaseUrl ?? ''}); setGroup(groupFor(kind)); if (filter) setFilter(kind)}} options={GLOBAL_SETTING_KINDS.filter(kind => kind === 'chat' || mediaKinds.includes(kind) || entries.some(entry => entry.kind === kind)).map(kind => ({value: kind, label: kindLabels[kind]}))}/></label>
              <section aria-label="默认配置" className="global-settings-defaults">{groupKinds.map(kind => {
                const available = entries.filter(entry => entry.enabled && entry.kind === kind), wanted = defaults[kind] === undefined ? saved.defaults[kind] : defaults[kind]
                return <label className="global-settings-field" key={kind}><span>默认{kindLabels[kind]}配置</span><ConfigSelect aria-label={`默认${kindLabels[kind]}配置`} value={available.some(entry => entry.id === wanted) ? wanted ?? '' : ''} disabled={busy} onChange={value => setDefaults(previous => ({...previous, [kind]: value || null}))} options={[{value: '', label: '未指定默认'}, ...available.map(entry => ({value: entry.id, label: entry.label}))]}/></label>
              })}</section>
              <div className="global-settings-entry-actions">{current.hasKey && (clearKeys.includes(current.id) ? <button type="button" onClick={() => setClearKeys(previous => previous.filter(id => id !== current.id))}>取消清空密钥</button> : <button type="button" data-variant="danger" onClick={() => setConfirmation({kind: 'clear', id: current.id})}>清空密钥</button>)}<button type="button" data-variant="danger" onClick={() => setConfirmation({kind: 'remove', id: current.id})}>删除配置</button></div>
            </details>
          </fieldset></div> : group === 'media' ? <div className="global-settings-capabilities">{mediaKinds.filter(kind => !filter || kind === filter).map(kind => <div className="global-settings-capability" key={kind}><div className="global-settings-capability-icon"><ConfigIcon kind="picture"/></div><div><strong>{kindLabels[kind]}</strong><p>{({image_generation: '根据描述生成图片', image_analysis: '识别图片内容与图文信息', video_analysis: '解析视频内容', web_search: '检索网页与实时信息', image_search: '搜索图片素材'} as Partial<Record<GlobalSettingKind, string>>)[kind]}</p></div><button type="button" disabled={busy || entries.length >= 100} onClick={() => add(kind)}>配置{kindLabels[kind]}</button></div>)}</div> : <div className="global-settings-empty"><ConfigIcon kind="model"/><h4>添加团队的第一个 AI 模型</h4><p>配置服务商和 API Key 后，团队成员即可使用 AI 助手。</p><button type="button" data-variant="primary" onClick={() => add()}>添加 AI 模型</button></div>}
          </>}
        </form>}
        {saved && <details className="global-settings-maintenance"><summary>高级维护<span>配置核对与加密维护</span></summary>
          <div className="global-settings-maintenance-actions"><button type="button" disabled={busy} onClick={() => void readLatest(true, true)}>读取最新配置</button><button type="button" disabled={busy || !dirty} onClick={() => setConfirmation({kind: 'discard'})}>放弃草稿并重新加载</button><button type="button" disabled={blocked} onClick={() => void check()}>检查已保存配置</button></div>
          <details className="global-settings-latest"><summary>查看已保存配置</summary><ul>{saved.entries.slice(currentServerPage * 10, (currentServerPage + 1) * 10).map(entry => <li key={entry.id}><strong>{entry.label}</strong> · {kindLabels[entry.kind]} · {entry.providerId} · {entry.model || '未指定模型'} · {entry.enabled ? '已启用' : '已停用'} · {entry.hasKey ? '已保存密钥' : '未保存密钥'}<span>{entry.baseUrl}</span></li>)}</ul><NativeSettingsPager page={currentServerPage} pageSize={10} total={saved.entries.length} onPageChange={setServerPage} label="服务器当前配置" disabled={busy}/>{!saved.entries.length && <p>尚无已保存配置。</p>}</details>
          <div className="global-settings-key-maintenance"><div><strong>重新加密已保存密钥</strong><p>仅服务器更换加密主密钥后使用，不会更换服务商 API Key。</p></div><button type="button" disabled={blocked || !saved.keyStorageAvailable} onClick={() => setConfirmation({kind: 'rotate'})}>轮换加密密钥</button></div>
        </details>}
      </div>
    </div>
  </section>
}
