import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import './database-connections.css'
import type { SourceDetail, SourceDescriptor, SourceDiscovery, SourceConfig, SourceKind } from '../../../../packages/web-contracts/src/sources.ts'
import type { SourcesClient } from './sources-client'

function Notice({type,title,description,role}: {type:'error'|'success'|'warning'|'info';title:ReactNode;description?:ReactNode;showIcon?:boolean;role?:'status'}) {
  return <div className={`dc-notice dc-notice--${type}`} role={role??(type==='error'||type==='warning'?'alert':'status')}><strong>{title}</strong>{description&&<div>{description}</div>}</div>
}

const connectionTabLabels = { connection:'连接设置', scope:'可见范围', advanced:'高级配置' } as const
const maxScopeEntries = 256
const credentialExamples = {
  postgres:'postgresql://reader:密码@db.example:5432/reporting',
  mysql:'mysql://reader:密码@db.example:3306/reporting',
  starrocks:'starrocks://reader:密码@db.example:9030/reporting',
  http:'',
}
const testAdvice: Record<string, string> = {
  READONLY_ROLE_REQUIRED:'账号未通过最小只读权限核验。请使用专用只读账号，不能使用 root 或管理角色。',
  SOURCE_TIMEOUT:'连接超时，请检查数据库地址、网络和执行时限。',
  SOURCE_TLS_UNSUPPORTED:'目标数据库不支持 TLS。请在全局配置中核对该目标是否启用了「使用 TLS」；如需普通连接，请关闭该选项。',
  TARGET_NOT_APPROVED:'请在全局配置中核对允许的连接目标和网络地址。',
}
type ConnectionTab = keyof typeof connectionTabLabels
const connectionTabs=Object.keys(connectionTabLabels) as ConnectionTab[]
type DirectoryTables = {directory:string;result:SourceDiscovery}
type Catalog = {sourceId:string;version:number;directories:SourceDiscovery;tables?:DirectoryTables;recent?:DirectoryTables[]}
type Draft = { sourceId: string; name: string; kind: SourceKind; config: string; credentialMode: 'retain' | 'replace' | 'clear'; secret: string; enabled: boolean }
const empty = (): Draft => ({ sourceId: '', name: '', kind: 'postgres', config: '{\n  "timezone": "UTC",\n  "maxRows": 1000,\n  "units": {},\n  "allowedTables": []\n}', credentialMode: 'replace', secret: '', enabled: true })
const fromDetail = (detail: SourceDetail): Draft => ({ sourceId: detail.source.sourceId, name: detail.source.name, kind: detail.source.kind,
  config: JSON.stringify(detail.config, null, 2), credentialMode: 'retain', secret: '', enabled: detail.source.enabled })

export function SourcesPanel({ client, onClose, presentation = 'dialog', onCloseGuardChange }: { client: SourcesClient; onClose: () => void; presentation?: 'dialog' | 'page'; onCloseGuardChange?: (guard: (() => boolean) | null) => void }) {
  const [items, setItems] = useState<SourceDescriptor[]>([]), [cursor, setCursor] = useState<string | null>(null)
  const [listState,setListState]=useState<'loading'|'ready'|'error'>('loading')
  const [listPage,setListPage]=useState(0),[pageStarts,setPageStarts]=useState<(string|undefined)[]>([undefined])
  const [detail, setDetail] = useState<SourceDetail | null>(null), [latest, setLatest] = useState<SourceDetail | null>(null)
  const [missing, setMissing] = useState<string|null>(null)
  const [draft, setDraft] = useState<Draft>(empty), [confirmDelete, setConfirmDelete] = useState(false)
  const [tab,setTab] = useState<ConnectionTab>('connection')
  const [catalogFilter,setCatalogFilter] = useState('')
  const [selectedOnly,setSelectedOnly] = useState(false)
  const [catalogLoading,setCatalogLoading] = useState('')
  const [catalogError,setCatalogError] = useState<{message:string;directory?:string}>()
  const [directoryFilter,setDirectoryFilter] = useState('')
  const [tested,setTested] = useState<SourceDetail['source']>()
  const [testing,setTesting] = useState(false)
  const [fieldError,setFieldError] = useState<{field:'name'|'sourceId'|'secret';message:string}>()
  const [catalog, setCatalog] = useState<Catalog>()
  const [filter, setFilter] = useState(''), [view, setView] = useState<'list'|'form'>('list')
  const [message, setMessage] = useState(''), [error, setError] = useState(''), [, tick] = useState(0)
  const alive = useRef(true), busy = client.getState().pending, unknown = client.getState().unknownWrite
  const inputRef = useRef<HTMLInputElement>(null)
  const focusCredential = useRef(false)
  const surfaceRef = useRef<HTMLElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const previousView = useRef(view)
  const isPage = presentation === 'page'
  useEffect(() => {
    if (fieldError) surfaceRef.current?.querySelector<HTMLInputElement>('input[aria-invalid="true"]')?.focus()
  }, [fieldError])
  useEffect(() => {
    if (tab==='connection'&&focusCredential.current) {
      focusCredential.current=false
      inputRef.current?.focus()
    }
  }, [tab])
  useEffect(() => {
    if (previousView.current === view || busy) return
    previousView.current = view
    if (!isPage) return
    if (surfaceRef.current) surfaceRef.current.scrollTop = 0
    const nextFocus = view === 'form' ? headingRef.current : searchRef.current
    nextFocus?.focus({preventScroll: true})
  }, [busy, isPage, view])
  useEffect(() => {
    alive.current = true
    let current=true
    setListState('loading')
    const unsubscribe = client.subscribe(() => { if (alive.current) tick(n => n + 1) })
    void client.list().then(page => { if (current) { setItems(page.items); setCursor(page.nextCursor); setListPage(0); setPageStarts([undefined]); setListState('ready') } }).catch(e => { if (current) { setError(e.message); setListState('error') } })
    return () => { current=false; alive.current = false; unsubscribe(); if (inputRef.current) inputRef.current.value = '' }
  }, [client])
  const legacyHttp = detail?.source.kind === 'http'
  const searchTerm = filter.trim().toLocaleLowerCase()
  const visibleItems = items.filter(item => `${item.name} ${item.sourceId} ${item.kind}`.toLocaleLowerCase().includes(searchTerm))
  const dirty = view === 'form' && JSON.stringify(draft) !== JSON.stringify(detail ? fromDetail(detail) : empty())
  function canClose() {
    if (client.getState().pending) { setError('连接操作处理中，请完成后再关闭。'); return false }
    if (client.getState().unknownWrite) { setError('操作结果尚未确认，请先核对后再关闭。'); return false }
    return !dirty || window.confirm('当前有未保存的连接修改，确定放弃并关闭？')
  }
  useEffect(() => {
    onCloseGuardChange?.(busy || unknown || dirty ? canClose : null)
    return () => onCloseGuardChange?.(null)
  }, [onCloseGuardChange, busy, unknown, dirty])
  useEffect(() => {
    if (!busy && !unknown && !dirty) return
    const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', prevent)
    return () => window.removeEventListener('beforeunload', prevent)
  }, [busy, unknown, dirty])
  const patch = (value: Partial<Draft>) => { setDraft(current => ({ ...current, ...value })); if(fieldError&&fieldError.field in value)setFieldError(undefined); setLatest(null); setConfirmDelete(false); setMessage('') }
  let publicConfig: Record<string, unknown> | null = null
  try { const value = JSON.parse(draft.config); if (value && typeof value === 'object' && !Array.isArray(value)) publicConfig = value } catch { /* Advanced JSON validation is reported on save. */ }
  function patchConfig(key: string, value: string | number) {
    if (publicConfig) patch({config: JSON.stringify({...publicConfig, [key]: value}, null, 2)})
  }
  const discovered = detail && catalog?.sourceId === detail.source.sourceId && catalog.version === detail.source.version ? catalog : undefined
  const discoveryBlock = !publicConfig ? {message:'请先在高级配置中修正公开配置。',tab:'advanced'} as const
    : !detail ? {message:'请先填写并保存连接，再读取目录和表。',tab:'connection'} as const
    : !draft.enabled ? {message:'连接已停用。启用并保存后才能读取目录和表。',tab:'connection'} as const
    : draft.credentialMode!=='retain' ? {message:'连接凭据有未保存的更改。请先保存可用的连接凭据。',tab:'connection'} as const
    : !detail.source.hasCredential ? {message:'连接还没有凭据。请输入连接地址并保存。',tab:'connection'} as const
    : !detail.source.enabled ? {message:'请先保存启用状态，再读取目录和表。',tab:'connection'} as const
    : publicConfig.database!==('database' in detail.config ? detail.config.database : undefined) ? {message:'数据库名称有未保存的更改。请先保存连接。'} as const
    : undefined
  const canDiscover = !discoveryBlock
  const discoveryTab = discoveryBlock?.tab
  function navigateTabs(event:KeyboardEvent<HTMLElement>) {
    if (busy) return
    const index=connectionTabs.indexOf(tab), last=connectionTabs.length-1
    const next=event.key==='ArrowRight'?(index+1)%connectionTabs.length
      : event.key==='ArrowLeft'?(index+last)%connectionTabs.length
      : event.key==='Home'?0:event.key==='End'?last:-1
    if (next<0) return
    event.preventDefault()
    const target=connectionTabs[next]
    setTab(target)
    event.currentTarget.querySelector<HTMLButtonElement>('#dc-tab-'+target)?.focus()
  }
  async function discover(directory?:string) {
    if (!detail || !canDiscover) return
    setCatalogError(undefined)
    const cached=directory!==undefined?discovered?.recent?.find(tables=>tables.directory===directory):undefined
    if (cached&&discovered) {
      if (cached!==discovered.tables) setCatalogFilter('')
      showTables(discovered,cached)
      return
    }
    setCatalogLoading(directory === undefined ? '正在读取目录…' : `正在读取 ${directory} 的表…`)
    try { await loadCatalog(detail,directory) }
    catch (error) {
      if (alive.current) setCatalogError({directory,message:`${directory===undefined?'无法读取目录和表':'无法读取 '+directory+' 的表'}。`+(error as Error).message})
    }
    finally { if (alive.current) setCatalogLoading('') }
  }
  function showTables(catalog:Catalog,tables:DirectoryTables) {
    setCatalog({...catalog,tables,recent:[tables,...(catalog.recent??[]).filter(item=>item.directory!==tables.directory)].slice(0,6)})
  }
  async function loadCatalog(connection: SourceDetail,directory?:string,restoreDirectory?:string) {
    const {sourceId,version}=connection.source
    const result=await client.discover(sourceId,version,directory)
    if (!alive.current) return
    if (restoreDirectory===undefined) setCatalogFilter('')
    if (directory !== undefined) {
      if (discovered) showTables(discovered,{directory,result})
      return
    }
    const catalog={sourceId,version,directories:result}
    if (restoreDirectory===undefined) setDirectoryFilter('')
    setCatalog(catalog)
    const directoryToOpen=restoreDirectory&&result.items.includes(restoreDirectory)?restoreDirectory
      : !result.truncated&&result.items.length===1?result.items[0]:undefined
    if (!directoryToOpen) return
    if (restoreDirectory!==directoryToOpen) setCatalogFilter('')
    setCatalogLoading(`正在读取 ${directoryToOpen} 的表…`)
    try {
      const tables=await client.discover(sourceId,version,directoryToOpen)
      if (alive.current) showTables(catalog,{directory:directoryToOpen,result:tables})
    } catch (error) {
      if (alive.current) setCatalogError({directory:directoryToOpen,message:`已读取目录，但未能自动读取 ${directoryToOpen} 的表。`+(error as Error).message})
    }
  }
  const selection = (key:'allowedSchemas'|'allowedTables') => {
    const values = publicConfig?.[key]
    return Array.isArray(values) ? [...new Set(values.filter((value):value is string=>typeof value==='string').map(value=>value.trim()).filter(Boolean))] : undefined
  }
  const selectedDirectories=selection('allowedSchemas'), selectedTables=selection('allowedTables')
  const defaultTableDirectory=draft.kind==='postgres'?'public'
    : typeof publicConfig?.database==='string'?publicConfig.database
    : canDiscover&&!discovered?.directories.truncated&&discovered?.directories.items.length===1?discovered.directories.items[0]:undefined
  const blockedTables=new Set(selectedDirectories&&selectedTables?.filter(table=>{
    const separator=table.indexOf('.')
    const directory=separator<0?defaultTableDirectory:table.slice(0,separator)
    return selectedDirectories.length===0 || directory!==undefined&&!selectedDirectories.includes(directory)
  }) || [])
  const matchingDirectories=discovered?.directories.items.filter(name=>name.toLowerCase().includes(directoryFilter.trim().toLowerCase()))
  const tableSearch=catalogFilter.trim().toLowerCase()
  const filterSelected=!!selectedTables&&selectedOnly
  const directoryLimit=(selectedDirectories?.length??0)>=maxScopeEntries
  const tableLimit=(selectedTables?.length??0)>=maxScopeEntries
  const tableDirectory=discovered?.tables?.directory
  const selectedTableIds=new Set(selectedTables)
  const availableTables=discovered?.tables?.result.items.map(name=>{
    const id=tableDirectory+'.'+name
    const alias=draft.kind==='postgres'&&tableDirectory!=='public'?undefined:name
    const checked=selectedTableIds.has(id)||(alias!==undefined&&selectedTableIds.has(alias))
    return {name,id,alias,checked}
  })??[]
  const matchingTables=availableTables.filter(table=>(!filterSelected||table.checked)&&table.name.toLowerCase().includes(tableSearch))
  const bulkTables=selectedTables&&matchingTables.length?matchingTables:undefined
  const bulkLabel=filterSelected?'列表中的已选表':tableSearch?'搜索结果':discovered?.tables?.result.truncated?'已读取的表':'当前目录'
  const tablesToAdd=bulkTables?.filter(table=>!table.checked).map(table=>table.id)??[]
  const tablesToRemove=new Set(bulkTables?.filter(table=>table.checked).flatMap(table=>[table.id,table.alias]))
  const exceedsTableLimit=(selectedTables?.length??0)+tablesToAdd.length>maxScopeEntries
  function setTableSelection(values:string[]) {
    if (!publicConfig||!selectedTables) return
    patch({config:JSON.stringify({...publicConfig,allowedTables:values},null,2)})
  }
  function toggleScope(key:'allowedSchemas'|'allowedTables', value:string, checked:boolean, alias?:string) {
    const values=selection(key)
    if (!publicConfig || !values || (checked&&values.length>=maxScopeEntries)) return
    const next=values.filter(item=>item!==value&&item!==alias)
    if (checked) next.push(value)
    patch({config:JSON.stringify({...publicConfig,[key]:next},null,2)})
  }
  const scopeKeys=['allowedSchemas','allowedTables'] as const
  const savedConfig=detail?.config as Record<string,unknown>|undefined
  const scopeChanged=publicConfig&&savedConfig&&scopeKeys.some(key=>JSON.stringify(publicConfig[key])!==JSON.stringify(savedConfig[key]))
  function restoreScope() {
    if (!publicConfig||!savedConfig) return
    const next={...publicConfig}
    for (const key of scopeKeys) {
      if (Object.hasOwn(savedConfig,key)) next[key]=savedConfig[key]
      else delete next[key]
    }
    patch({config:JSON.stringify(next,null,2)})
  }
  function reviewSelection(key:'allowedSchemas'|'allowedTables', label:'目录'|'表', values:string[]|undefined) {
    if (!values?.length) return null
    return <details className="dc-selection" open>
      <summary>已选{label}（{values.length}）</summary>
      <ul aria-label={`已选${label}`}>{values.map(value=><li key={value}>
        <span>{value}{key==='allowedTables'&&blockedTables.has(value)&&<small className="dc-scope-blocked">目录未开放</small>}</span>
        <button type="button" aria-label={`移除${label} ${value}`} onClick={event=>{
          const button=event.currentTarget
          const item=button.closest('li')
          const next=(item?.nextElementSibling??item?.previousElementSibling)?.querySelector<HTMLButtonElement>('button')
          const fallback=surfaceRef.current?.querySelector<HTMLSelectElement>(`select[aria-label="${key==='allowedSchemas'?'目录范围':'表可见范围'}"]`)
          ;(next??fallback)?.focus()
          toggleScope(key,value,false)
        }}>×</button>
      </li>)}</ul>
    </details>
  }
  async function operation(action: () => Promise<unknown>, clearSubmittedSecret = false) {
    if (busy) return
    setError(''); setMessage('')
    try { await action() } catch (e) { if (alive.current) setError((e as Error).message) }
    finally { if (alive.current && clearSubmittedSecret) { setDraft(current => ({ ...current, secret: '' })); if (inputRef.current) inputRef.current.value = '' } }
  }
  async function reloadList(targetPage=0,after?:string) {
    setListState('loading')
    try{
      const page = await client.list(after)
      if (alive.current) { setItems(page.items); setCursor(page.nextCursor); setListPage(targetPage); setPageStarts(old=>targetPage===0?[undefined]:[...old.slice(0,targetPage),after]); setListState('ready') }
    }catch(error){if(alive.current)setListState('error');throw error}
  }
  function changeListPage(next:number) {
    if(client.getState().pending||dirty||client.getState().unknownWrite)return
    if(next===listPage+1&&cursor)void operation(()=>reloadList(next,cursor))
    else if(next===listPage-1&&next>=0)void operation(()=>reloadList(next,pageStarts[next]))
  }
  async function select(sourceId: string, keepTab = false) {
    const value = await client.detail(sourceId)
    if (alive.current&&!keepTab) setSelectedOnly(false)
    if (alive.current) { if (!keepTab) setTab('connection'); setDetail(value); setCatalog(undefined); setCatalogError(undefined); setTested(undefined); setFieldError(undefined); setDraft(fromDetail(value)); setLatest(null); setMissing(null); setConfirmDelete(false); setView('form') }
    return value
  }
  async function readLatest(sourceId:string){
    setMissing(null)
    try{const current=await client.detail(sourceId);if(alive.current){setLatest(current);setMessage('最新配置已读取，当前编辑仍保留。')}}
    catch(error){if((error as {status?:number}).status!==404)throw error;if(alive.current){setLatest(null);setMissing(sourceId)}}
  }
  async function save() {
    if (legacyHttp || draft.kind === 'http') throw Error('已有 HTTP 连接仅支持只读查看，请新建数据库连接。')
    let config: SourceConfig
    try {
      const value: unknown = JSON.parse(draft.config)
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('invalid')
      const fields:Record<string,unknown> = {...value}
      for (const key of scopeKeys) {
        const entries=fields[key]
        if (Array.isArray(entries)) fields[key]=[...new Set(entries.map(value=>typeof value==='string'?value.trim():value).filter(value=>value!==''))]
      }
      config = fields as SourceConfig
    } catch { throw Error('公开配置必须是有效的 JSON 对象，不能包含连接地址或密码。') }
    for (const key of scopeKeys) {
      const entries=(config as Record<string,unknown>)[key]
      const unit=key==='allowedSchemas'?' 个目录':' 张表'
      if (Array.isArray(entries)&&entries.length>maxScopeEntries) {
        setTab('scope')
        throw Error(`填写了 ${entries.length}${unit}，最多可选 ${maxScopeEntries}${unit}。`)
      }
    }
    if (!detail) {
      if (!draft.secret) throw Error('创建连接必须填写连接凭据。')
      await client.create({ sourceId: draft.sourceId, name: draft.name, kind: draft.kind, config, secret: draft.secret, enabled: draft.enabled })
    } else await client.save(detail.source.sourceId, { expectedVersion: detail.source.version, name: draft.name, config, enabled: draft.enabled,
      ...(draft.credentialMode === 'replace' ? { secret: draft.secret } : draft.credentialMode === 'clear' ? { secret: null } : {}) })
    if (!alive.current) return
    let current:SourceDetail
    try { current=await select(draft.sourceId,true) }
    catch { throw Error('连接已保存，但未能重新读取配置。请返回连接列表后重试。') }
    await reloadList().catch(()=>{/* The list already shows its own retry state when opened. */})
    const restore=tab==='scope'&&canDiscover?discovered?.tables?.directory:undefined
    if (restore && current.source.enabled && current.source.hasCredential && alive.current) {
      setCatalogLoading('正在读取目录…')
      try { await loadCatalog(current,undefined,restore) }
      catch (error) { if(alive.current)setCatalogError({message:'范围已保存，但未能刷新目录和表。'+(error as Error).message}) }
      finally { if(alive.current)setCatalogLoading('') }
    }
    if (alive.current) setMessage(!current.source.enabled?'连接已保存，当前已停用。':!current.source.hasCredential?'连接已保存，请配置凭据后再测试连接。':'连接已保存并生效，可测试连接。')
    return current
  }
  function validateConnection() {
    if (!isPage||!publicConfig) return true
    let credentialIssue:string|undefined
    if (draft.kind!=='http'&&(!detail||draft.credentialMode==='replace')) {
      const prefix=(draft.kind==='postgres'?'postgresql':draft.kind)+'://'
      if (!draft.secret.trim()) credentialIssue='请输入数据库连接地址。'
      else if (!draft.secret.toLowerCase().startsWith(prefix)) credentialIssue='连接地址应以 '+prefix+' 开头。'
      else {
        try {
          const address=new URL(draft.secret)
          if (!address.hostname) credentialIssue='请在连接地址中填写服务器地址。'
          else if (!address.username||!address.password) credentialIssue='请在连接地址中填写用户名和密码。'
          else if (!address.pathname||address.pathname==='/') credentialIssue='请在连接地址末尾填写数据库名。'
          else if (address.search||address.hash) credentialIssue='连接地址不能包含查询参数或片段。'
          else if (typeof publicConfig.database==='string'&&decodeURIComponent(address.pathname.slice(1))!==publicConfig.database) credentialIssue='连接地址中的数据库名应与「可见范围」中的数据库名称一致。'
        } catch { credentialIssue='连接地址格式无效，请参考下方示例。' }
      }
    }
    const issue = !draft.name.trim() ? {field:'name',message:'请输入连接名称。'} as const
      : !detail&&!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(draft.sourceId) ? {field:'sourceId',message:'用字母或数字开头，可包含下划线、连字符和点。'} as const
      : credentialIssue ? {field:'secret',message:credentialIssue} as const
      : undefined
    setFieldError(issue)
    if (!issue) return true
    setTab('connection')
    return false
  }
  async function testConnection(connection:SourceDetail,saved=false) {
    setTested(undefined)
    setTesting(true)
    const prefix=saved?'连接已保存，但测试未通过。':'连接测试未通过。'
    try {
      const checked=await client.test(connection.source.sourceId)
      if (!alive.current) return
      if (checked.ok) {
        setTested(connection.source)
        setMessage(saved?'连接已保存，测试通过。':'连接测试通过。')
      } else {
        setMessage('')
        setError(prefix+(testAdvice[checked.code??'']??'请检查地址、TLS 和账号凭据。'))
      }
    } catch (error) {
      if(alive.current){setMessage('');setError(prefix+(error as Error).message)}
    } finally { if (alive.current) setTesting(false) }
  }
  function submit(testAfterSave=false) {
    if (!validateConnection()) return
    void operation(async()=>{
      const current=await save()
      if (testAfterSave&&current?.source.enabled&&current.source.hasCredential&&alive.current) await testConnection(current,true)
    },true)
  }
  function backToList() {
    if (busy || dirty && !window.confirm('当前有未保存的连接修改，确定放弃并返回列表？')) return
    setTab('connection'); setView('list'); setDetail(null); setDraft(empty()); setTested(undefined); setFieldError(undefined); setLatest(null); setMissing(null); setConfirmDelete(false); setMessage(''); setError(''); setCatalogError(undefined); setSelectedOnly(false)
  }
  const canSaveAndTest = isPage&&tab==='connection'&&draft.enabled&&draft.credentialMode!=='clear'&&(!detail||draft.credentialMode==='replace'||detail.source.hasCredential)
  const canChooseScope = isPage&&tab==='connection'&&!dirty&&canDiscover&&tested?.sourceId===detail?.source.sourceId&&tested?.version===detail?.source.version
  const inlineFeedback = isPage && view === 'form'
  const fieldFeedback = (field:NonNullable<typeof fieldError>['field']) => fieldError?.field===field ? <small id={'dc-error-'+field} className="dc-field-error" role="alert">{fieldError.message}</small> : null
  const fieldAttributes = (field:NonNullable<typeof fieldError>['field']) => fieldError?.field===field ? {'aria-invalid':true as const,'aria-describedby':'dc-error-'+field} : {}
  const resultNotice = error
    ? <Notice type="error" title={error}/>
    : message && <Notice type="success" title={message} role="status"/>
  return <div className={`database-connections database-connections--${presentation}`}><section ref={surfaceRef} className="database-connections-surface" role={presentation === 'dialog' ? 'dialog' : undefined} aria-modal={presentation === 'dialog' ? true : undefined} aria-label="数据连接">
    <header className={`database-connections-header${view === 'form' ? ' database-connections-header--editor' : ''}`}>
      <div>
        {view === 'form' && <button disabled={busy} onClick={backToList}>返回连接列表</button>}
        <h2 ref={headingRef} tabIndex={inlineFeedback ? -1 : undefined} title={inlineFeedback ? detail?.source.name : undefined}>{view==='list'?'数据连接':detail?`编辑连接 · ${detail.source.name}`:'新建数据连接'}</h2>
        <p>{view==='list'?'管理数据库连接、访问凭据与可见目录和表。':'保存即生效，请使用只读账号。'}</p>
      </div>
      {presentation==='dialog'&&<button disabled={busy} onClick={()=>{if(canClose())onClose()}}>关闭</button>}
    </header>
    <div className="database-connections-notices">
      {!inlineFeedback && resultNotice}
      {unknown&&<Notice type="warning" showIcon title="上次写入结果未确认" description={<div><p>请读取「{client.getState().unknownSourceId}」的最新配置，核对后再继续保存。</p><button disabled={busy} onClick={()=>void operation(()=>readLatest(client.getState().unknownSourceId!))}>读取待核对连接（{client.getState().unknownSourceId}）</button></div>}/>}
      {missing&&<Notice type="info" title="服务器确认此连接已不存在。当前本地编辑仍保留。" description={<button disabled={busy} onClick={()=>{client.acknowledgeLatest(missing);setDetail(null);setDraft(empty());setMissing(null);setView('form');void operation(()=>reloadList())}}>确认不存在并开始新建</button>}/>}
      {latest&&<Notice type="info" title="已读取服务器当前配置，请核对后决定是否放弃本地修改。" description={<button disabled={busy} onClick={()=>{client.acknowledgeLatest(latest.source.sourceId);setDetail(latest);setDraft(fromDetail(latest));setLatest(null);setView('form')}}>采用服务器配置并放弃修改</button>}/>}
    </div>
    {view==='list'?<main className="database-connections-list">
      <div className="database-connections-toolbar"><input ref={searchRef} aria-label="搜索数据连接" placeholder="搜索当前页名称、标识或类型" value={filter} disabled={busy} onChange={event=>setFilter(event.target.value)}/><div className="dc-inline"><button disabled={busy} onClick={()=>void operation(()=>reloadList())}>刷新列表</button><button className="dc-primary" disabled={busy||unknown} onClick={()=>{setDetail(null);setDraft(empty());setLatest(null);setMissing(null);setConfirmDelete(false);setError('');setMessage('');setView('form')}}>新建数据连接</button></div></div>
      {visibleItems.length > 0 && <div className="database-connections-table" role="table" aria-label="连接列表"><div className="database-connections-columns" role="row"><span role="columnheader">名称</span><span role="columnheader">类型</span><span role="columnheader">状态</span><span role="columnheader">凭据</span><span role="columnheader">操作</span></div>
        {visibleItems.map(item=><div className="database-connection-row" role="row" key={item.sourceId}><div role="cell"><button className="database-connection-name" disabled={busy} onClick={()=>void operation(()=>select(item.sourceId))}>{item.name}</button><small>{item.sourceId}</small></div><span role="cell">{item.kind==='postgres'?'PostgreSQL':item.kind==='mysql'?'MySQL':item.kind==='starrocks'?'StarRocks':'HTTP（只读）'}</span><span role="cell"><span className={item.enabled?"dc-badge dc-badge--enabled":"dc-badge"}>{item.enabled?'已启用':'已停用'}</span></span><span role="cell">{item.hasCredential?'已配置':'未配置'}</span><span role="cell"><button aria-label={`${item.kind==='http'?'查看':'编辑'}连接 ${item.name}`} disabled={busy} onClick={()=>void operation(()=>select(item.sourceId))}>{item.kind==='http'?'查看':'编辑'}</button></span></div>)}
      </div>}
      {listState==='loading'&&<p className="database-connections-empty" role="status">正在加载数据连接…</p>}
      {listState==='error'&&<p className="database-connections-empty">数据连接列表未能加载，请刷新列表重试。</p>}
      {listState==='ready'&&!visibleItems.length&&<div className="database-connections-empty"><p>{searchTerm?'当前页没有匹配的连接':'尚未配置数据连接'}</p>{searchTerm&&<button onClick={()=>setFilter('')}>清除筛选</button>}</div>}
      <nav className="dc-pagination" aria-label="数据连接分页"><button aria-label="上一页数据连接" disabled={busy||unknown||listPage===0} onClick={()=>changeListPage(listPage-1)}>上一页</button><span role="status">第 {listPage+1} 页</span><button aria-label="下一页数据连接" disabled={busy||unknown||!cursor} onClick={()=>changeListPage(listPage+1)}>下一页</button></nav>
    </main>:<main className="database-connections-form">
      {isPage&&!legacyHttp&&<nav role="tablist" aria-label="数据连接分类" className="dc-category-tabs" onKeyDown={navigateTabs}>
        {connectionTabs.map(category=><button key={category} type="button" role="tab" id={`dc-tab-${category}`} aria-controls={`dc-panel-${category}`} aria-selected={tab===category} tabIndex={tab===category?0:-1} disabled={busy} onClick={()=>setTab(category)}>{connectionTabLabels[category]}</button>)}
      </nav>}
      {legacyHttp&&<Notice type="info" showIcon title="已有 HTTP 连接仅支持只读查看。新建连接仅支持 PostgreSQL、MySQL 和 StarRocks。"/>}
      {dirty&&!inlineFeedback&&<p className="database-connections-dirty" role="status">当前有未保存修改，离开前请保存或明确放弃。</p>}
      <div className="dc-category-panel" id="dc-panel-connection" role={isPage&&!legacyHttp?'tabpanel':undefined} aria-labelledby={isPage&&!legacyHttp?'dc-tab-connection':undefined} hidden={isPage&&tab!=='connection'}>
      <fieldset disabled={busy||unknown||legacyHttp}><legend>基础信息</legend><div className="database-connections-grid">
        <label>名称<input {...fieldAttributes('name')} aria-label="连接名称" disabled={busy||unknown||legacyHttp} value={draft.name} maxLength={200} placeholder="例如：业务分析数据库" onChange={event=>patch({name:event.target.value})}/>{fieldFeedback('name')}</label>
        <label>连接标识<input {...fieldAttributes('sourceId')} aria-label="连接标识" disabled={!!detail||busy||unknown||legacyHttp} value={draft.sourceId} maxLength={64} placeholder="例如：sales-db" onChange={event=>patch({sourceId:event.target.value})}/>{fieldFeedback('sourceId')}</label>
        <label>连接器<select aria-label="连接器" disabled={!!detail||busy||unknown} value={draft.kind} onChange={event=>patch({kind:event.target.value as SourceKind})}>{legacyHttp&&<option value="http">HTTP JSON（只读）</option>}<option value="postgres">PostgreSQL</option><option value="mysql">MySQL</option><option value="starrocks">StarRocks</option></select></label>
        <div className="database-connections-enabled"><label className="dc-check"><input type="checkbox" aria-label="启用数据连接" disabled={busy||unknown||legacyHttp} checked={draft.enabled} onChange={event=>patch({enabled:event.target.checked})}/>启用数据连接</label></div>
      </div></fieldset>
      <fieldset disabled={busy||unknown||legacyHttp}><legend>凭据</legend><p>连接地址与密码加密保存，已有凭据绝不回显。</p>
        {detail&&!legacyHttp&&<label>凭据操作<select aria-label="凭据操作" value={draft.credentialMode} disabled={busy||unknown} onChange={event=>patch({credentialMode:event.target.value as Draft['credentialMode'],secret:''})}><option value="retain">保留现有凭据{detail.source.hasCredential?'（已配置）':'（未配置）'}</option><option value="replace">替换凭据</option><option value="clear">清空连接凭据</option></select></label>}
        {!legacyHttp&&(!detail||draft.credentialMode==='replace')&&<label>数据库连接地址<input {...fieldAttributes('secret')} ref={inputRef} aria-label="连接凭据" type="password" autoComplete="new-password" value={draft.secret} placeholder="输入数据库只读连接地址" onChange={event=>patch({secret:event.target.value})}/><small>例如：<code>{credentialExamples[draft.kind]}</code></small>{fieldFeedback('secret')}</label>}
      </fieldset>
      </div>
      <div className="dc-category-panel" id="dc-panel-scope" role={isPage&&!legacyHttp?'tabpanel':undefined} aria-labelledby={isPage&&!legacyHttp?'dc-tab-scope':undefined} hidden={isPage&&tab!=='scope'}>
      <fieldset disabled={busy||unknown||legacyHttp}><legend>可见目录与表</legend><p>连接凭据绑定数据库。目录和表同时设置时，只能访问两者都允许的表。</p>
        {!legacyHttp&&<label>数据库名称（可选）<input aria-label="数据库名称" disabled={!publicConfig||busy||unknown} value={typeof publicConfig?.database==='string'?publicConfig.database:''} onChange={event=>{if(!publicConfig)return;const next={...publicConfig};const value=event.target.value.trim();if(value)next.database=value;else delete next.database;patch({config:JSON.stringify(next,null,2)})}}/><small>填写后必须与连接凭据中的数据库一致。</small></label>}
        {!legacyHttp&&<label>目录范围<select aria-label="目录范围" disabled={!publicConfig||busy||unknown} value={publicConfig&&Object.hasOwn(publicConfig,'allowedSchemas')?'selected':'all'} onChange={event=>{if(!publicConfig)return;const next={...publicConfig};if(event.target.value==='selected')next.allowedSchemas=[];else delete next.allowedSchemas;patch({config:JSON.stringify(next,null,2)})}}><option value="all">不限目录（仍受账号和表范围限制）</option><option value="selected">仅指定目录</option></select></label>}
        {!legacyHttp&&<label>表可见范围<select aria-label="表可见范围" disabled={!publicConfig||busy||unknown} value={publicConfig&&Object.hasOwn(publicConfig,'allowedTables')?'selected':'all'} onChange={event=>{const value=event.target.value;if(!publicConfig)return;const next={...publicConfig};if(value==='selected')next.allowedTables=[];else delete next.allowedTables;patch({config:JSON.stringify(next,null,2)});if(value==='selected'&&!discovered&&canDiscover)void operation(()=>discover())}}><option value="selected">仅指定表</option><option value="all">账号可读的全部表</option></select></label>}
        {!legacyHttp&&<p>{selectedDirectories ? '已选 '+selectedDirectories.length+' 个目录' : '不限目录'}、{selectedTables ? (selectedDirectories?'':'已选 ')+selectedTables.length+' 张表' : '账号可读的全部表'}</p>}
        {!legacyHttp&&scopeChanged&&<button type="button" onClick={restoreScope}>恢复已保存的目录和表</button>}
        {directoryLimit&&<p role="status">已达到 {maxScopeEntries} 个目录的上限。</p>}
        {tableLimit&&<p role="status">已达到 {maxScopeEntries} 张表的上限。</p>}
        {!legacyHttp&&(selectedDirectories?.length===0||selectedTables?.length===0)&&
          <p className="dc-scope-empty" role="status">尚未选择{selectedDirectories?.length===0?'目录':'表'}，保存后助手将看不到任何表。</p>}
        {!legacyHttp&&!!selectedDirectories?.length&&blockedTables.size>0&&
          <p className="dc-scope-empty" role="status">有 {blockedTables.size} 张已选表不在允许的目录内，保存后助手看不到这些表。</p>}
        {!legacyHttp&&reviewSelection('allowedSchemas','目录',selectedDirectories)}
        {!legacyHttp&&reviewSelection('allowedTables','表',selectedTables)}
        {!legacyHttp&&<section className="dc-discovery" aria-label="从数据库发现目录和表">
          <p>读取已保存连接中账号可见的目录和表。勾选后保存，助手才会使用新的范围。</p>
          <button type="button" disabled={!canDiscover} onClick={()=>void operation(()=>discover())}>{discovered?'重新读取目录和表':'读取目录和表'}</button>
          {catalogLoading&&<p role="status">{catalogLoading}</p>}
          {catalogError&&<Notice type="error" title={catalogError.message} description={canDiscover&&<div className="dc-inline">
            <button type="button" onClick={()=>void operation(()=>discover(catalogError.directory))}>{catalogError.directory===undefined?'重试读取目录':'重试读取表'}</button>
            <button type="button" onClick={()=>void operation(()=>{
            setCatalogError(undefined)
            return testConnection(detail!)
          })}>测试连接并查看原因</button></div>}/>}
          {discoveryBlock&&<div className="dc-directory-warning">
            <p>{discoveryBlock.message}</p>
            {isPage&&discoveryTab&&<button type="button" onClick={()=>{
              setTab(discoveryTab)
              if(discoveryTab==='connection'&&detail&&!detail.source.hasCredential&&draft.credentialMode==='retain') {
                focusCredential.current=true
                patch({credentialMode:'replace'})
              } else surfaceRef.current?.querySelector<HTMLButtonElement>('#dc-tab-'+discoveryTab)?.focus()
            }}>前往{connectionTabLabels[discoveryTab]}</button>}
          </div>}
          {discovered&&<>
            {discovered.directories.truncated&&<p role="status">目录仅显示前 1000 项，其余可手动填写。</p>}
            {!discovered.directories.items.length&&<p>这个账号没有可选目录。</p>}
            {discovered.directories.items.length>0&&<details className="dc-picker" open>
              <summary>{discovered.tables ? '目录：'+discovered.tables.directory : '搜索或选择目录'}</summary>
              <label>搜索目录<input aria-label="搜索目录" type="search" value={directoryFilter} onChange={event=>setDirectoryFilter(event.target.value)}/></label>
              {!matchingDirectories?.length&&<div className="dc-filter-empty">
                <p role="status">没有匹配的目录。</p>
                <button type="button" onClick={event=>{
                  setDirectoryFilter('')
                  event.currentTarget.closest('details')?.querySelector<HTMLInputElement>('input[type="search"]')?.focus()
                }}>清除目录搜索</button>
              </div>}
              <ul aria-label="可选目录">{matchingDirectories?.map(directory=><li key={directory}>
              {selectedDirectories ? <label className="dc-check"><input type="checkbox" aria-label={`允许目录 ${directory}`} checked={selectedDirectories.includes(directory)} disabled={directoryLimit&&!selectedDirectories.includes(directory)} onChange={event=>toggleScope('allowedSchemas',directory,event.target.checked)}/>{directory}</label> : <span>{directory}</span>}
              <button type="button" aria-current={discovered.tables?.directory===directory?true:undefined} disabled={!canDiscover} onClick={()=>void operation(()=>discover(directory))}>浏览 {directory} 的表</button>
            </li>)}</ul>
            </details>}
            {discovered.tables&&<details key={discovered.tables.directory} className="dc-picker" aria-label={`目录 ${discovered.tables.directory} 的表`} open>
              <summary>{discovered.tables.directory} 的表{selectedTables&&`（已选 ${availableTables.filter(table=>table.checked).length}）`}</summary>
              {publicConfig&&!selectedDirectories&&<button type="button" disabled={!canDiscover} onClick={event=>{
                patch({config:JSON.stringify({...publicConfig,allowedSchemas:[tableDirectory]},null,2)})
                event.currentTarget.closest('details')?.querySelector('summary')?.focus()
              }}>仅允许此目录</button>}
              {selectedDirectories&&!selectedDirectories.includes(discovered.tables.directory)&&<div className="dc-directory-warning">
                <p>此目录尚未选中，保存后其中的表仍不开放。</p>
                {selectedDirectories.length>=maxScopeEntries
                  ? <small>最多可选 {maxScopeEntries} 个目录，请先移除部分已选目录。</small>
                  : <>
                    <button type="button" disabled={!canDiscover} onClick={event=>{
                      toggleScope('allowedSchemas',discovered.tables!.directory,true)
                      event.currentTarget.closest('details')?.querySelector('summary')?.focus()
                    }}>允许此目录</button>
                    {!selectedTables&&<small>当前未限制具体表。允许此目录后，保存时会开放其中账号可读的表。</small>}
                  </>}
              </div>}
              {discovered.tables.result.truncated&&<p role="status">表仅显示前 1000 项，其余可手动填写。</p>}
              {!discovered.tables.result.items.length&&<p>此目录没有可选表。</p>}
              {discovered.tables.result.items.length>0&&<label>搜索表<input aria-label="搜索表" type="search" value={catalogFilter} onChange={event=>setCatalogFilter(event.target.value)}/></label>}
              {selectedTables&&discovered.tables.result.items.length>0&&<label className="dc-check"><input type="checkbox" aria-label="只看已选表" checked={selectedOnly} onChange={event=>setSelectedOnly(event.target.checked)}/>只看已选表</label>}
              {publicConfig&&!selectedTables&&discovered.tables.result.items.length>0&&<div className="dc-directory-warning">
                <p>当前允许范围内账号可读的全部表。只想开放部分表时，可以改为逐张勾选。</p>
                <button type="button" disabled={!canDiscover} onClick={event=>{
                  patch({config:JSON.stringify({...publicConfig,allowedTables:[]},null,2)})
                  event.currentTarget.closest('details')?.querySelector<HTMLInputElement>('input[type="search"]')?.focus()
                }}>改为勾选指定表</button>
              </div>}
              {(tableSearch||filterSelected)&&!matchingTables.length&&<div className="dc-filter-empty">
                <p role="status">{filterSelected?'没有匹配的已选表。':'没有匹配的表。'}</p>
                {tableSearch&&<button type="button" onClick={event=>{
                  setCatalogFilter('')
                  event.currentTarget.closest('details')?.querySelector<HTMLInputElement>('input[type="search"]')?.focus()
                }}>清除表搜索</button>}
              </div>}
              {bulkTables&&selectedTables&&<div className="dc-bulk-tables">
                <button type="button" disabled={!canDiscover||!tablesToAdd.length||exceedsTableLimit} onClick={()=>setTableSelection([...selectedTables,...tablesToAdd])}>勾选{bulkLabel}（{bulkTables.length}）</button>
                <button type="button" disabled={!canDiscover||!tablesToRemove.size} onClick={()=>setTableSelection(selectedTables.filter(id=>!tablesToRemove.has(id)))}>取消勾选{bulkLabel}（{bulkTables.length}）</button>
                <small role="status">当前列表已勾选 {bulkTables.length-tablesToAdd.length} / {bulkTables.length} 张表。</small>
                {exceedsTableLimit&&<small>最多可选 {maxScopeEntries} 张表。请{tableSearch?'缩小搜索范围':'先搜索表名'}，或移除部分已选表。</small>}
              </div>}
              <ul aria-label="可选表">{matchingTables.map(({name,id,alias,checked})=><li key={id}>{selectedTables
                ? <label className="dc-check"><input type="checkbox" aria-label={`允许表 ${id}`} checked={checked} disabled={tableLimit&&!checked} onChange={event=>toggleScope('allowedTables',id,event.target.checked,alias)}/>{name}</label>
                : <span>{name}</span>}</li>)}</ul>
            </details>}
          </>}
        </section>}
        {(selectedDirectories||selectedTables)&&<details className="dc-manual-scope" open={!isPage}><summary>手工填写范围</summary>
        {!legacyHttp&&publicConfig&&Object.hasOwn(publicConfig,'allowedSchemas')&&<label>允许访问的目录<textarea aria-label="允许访问的目录" disabled={busy||unknown} rows={3} spellCheck={false} placeholder={draft.kind==='postgres'?'sales':'warehouse'} value={Array.isArray(publicConfig.allowedSchemas)?publicConfig.allowedSchemas.map(String).join('\n'):''} onChange={event=>patch({config:JSON.stringify({...publicConfig,allowedSchemas:event.target.value.split(/[\n,，]/)},null,2)})}/><small>每行一个名称。PostgreSQL 填 Schema；MySQL 或 StarRocks 填数据库名。留空不开放任何目录。</small></label>}
        {!legacyHttp&&publicConfig&&Object.hasOwn(publicConfig,'allowedTables')&&<label>允许访问的表<textarea aria-label="允许访问的表" disabled={busy||unknown} rows={4} spellCheck={false} placeholder={'public.orders\npublic.order_items'} value={Array.isArray(publicConfig.allowedTables)?publicConfig.allowedTables.map(String).join('\n'):''} onChange={event=>patch({config:JSON.stringify({...publicConfig,allowedTables:event.target.value.split(/[\n,，]/)},null,2)})}/><small>每行一个表，可填写 schema.table 或 database.table。留空不开放任何表。</small></label>}
        </details>}
      </fieldset>
      </div>
      <div className="dc-category-panel" id="dc-panel-advanced" role={isPage&&!legacyHttp?'tabpanel':undefined} aria-labelledby={isPage&&!legacyHttp?'dc-tab-advanced':undefined} hidden={isPage&&tab!=='advanced'}>
      <fieldset disabled={busy||unknown||legacyHttp}><legend>高级配置</legend><div className="database-connections-grid">
        <label>时区<input aria-label="时区" disabled={!publicConfig||busy||unknown||legacyHttp} placeholder="例如 Asia/Shanghai" value={typeof publicConfig?.timezone==='string'?publicConfig.timezone:''} onChange={event=>patchConfig('timezone',event.target.value)}/></label>
        <label>最大返回行数<input aria-label="查询最大行数" disabled={!publicConfig||busy||unknown||legacyHttp} type="number" min={1} max={10000} step={1} value={typeof publicConfig?.maxRows==='number'?publicConfig.maxRows:''} onChange={event=>patchConfig('maxRows',Number(event.target.value))}/></label>
        {draft.kind!=='http'&&<label>查询超时（毫秒）<input aria-label="查询超时毫秒数" disabled={!publicConfig||busy||unknown||legacyHttp} type="number" min={100} max={30000} step={100} placeholder="5000" value={typeof publicConfig?.statementTimeoutMs==='number'?publicConfig.statementTimeoutMs:''} onChange={event=>{if(event.target.value!=='')patchConfig('statementTimeoutMs',Number(event.target.value));else if(publicConfig){const {statementTimeoutMs:_,...rest}=publicConfig;patch({config:JSON.stringify(rest,null,2)})}}}/></label>}
      </div><details><summary>高级配置（公开 JSON 与字段单位）</summary><label>公开配置 JSON<textarea aria-label="公开配置 JSON" disabled={busy||unknown||legacyHttp} rows={7} spellCheck={false} value={draft.config} onChange={event=>patch({config:event.target.value})}/></label><p>只填写公开配置，连接地址与密码请使用凭据字段。</p></details></fieldset>
      </div>
      {detail&&(!isPage||tab==='connection')&&<section className="database-connections-danger" aria-label="删除连接"><h3>删除连接</h3><p>删除后不能再使用此连接，原标识不可重新创建。</p><label className="dc-check"><input type="checkbox" aria-label="确认删除此连接" disabled={busy||unknown||legacyHttp} checked={confirmDelete} onChange={event=>setConfirmDelete(event.target.checked)}/>确认删除此连接（保留不可复用的标识墓碑）</label><button className="dc-danger" disabled={busy||unknown||legacyHttp||!confirmDelete} onClick={()=>void operation(async()=>{await client.remove(detail.source.sourceId,detail.source.version);if(!alive.current)return;setDetail(null);setDraft(empty());setView('list');await reloadList()})}>删除连接</button></section>}
      <footer className="database-connections-actions">
        {testing&&<Notice type="info" title="正在测试连接…"/>}
        {inlineFeedback && (resultNotice || (dirty && <p className="database-connections-dirty" role="status">有未保存的修改。</p>))}
        <div>
          {canSaveAndTest&&<button className="dc-primary" disabled={busy||unknown||legacyHttp} onClick={()=>submit(true)}>保存并测试</button>}
          <button className={canSaveAndTest?undefined:'dc-primary'} disabled={busy||unknown||legacyHttp} onClick={()=>submit()}>保存连接</button>
          {canChooseScope&&<button disabled={busy||unknown} onClick={()=>{setTab('scope');if(!discovered)void operation(()=>discover())}}>选择可见范围</button>}
          <button disabled={busy||dirty||unknown||legacyHttp||!detail?.source.enabled||!detail.source.hasCredential} onClick={()=>void operation(()=>testConnection(detail!))}>测试连接</button>
          {dirty&&<button disabled={busy||unknown} onClick={()=>{setDraft(detail?fromDetail(detail):empty());setLatest(null);setFieldError(undefined);setError('')}}>放弃修改</button>}
        </div>{(detail||unknown&&draft.sourceId)&&<button disabled={busy} onClick={()=>void operation(()=>readLatest(detail?.source.sourceId??draft.sourceId))}>读取最新配置并核对</button>}
      </footer>
    </main>}
  </section></div>
}
