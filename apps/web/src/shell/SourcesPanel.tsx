import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import './database-connections.css'
import type { SourceDetail, SourceDescriptor, SourceDiscovery, SourceConfig, SourceKind } from '../../../../packages/web-contracts/src/sources.ts'
import type { SourcesClient } from './sources-client'
import { useI18n } from '../../../shell/src/renderer/src/locale'
import { translateSources, type SourcesStringKey } from './i18n/strings-sources'

function Notice({type,title,description,role}: {type:'error'|'success'|'warning'|'info';title:ReactNode;description?:ReactNode;showIcon?:boolean;role?:'status'}) {
  return <div className={`dc-notice dc-notice--${type}`} role={role??(type==='error'||type==='warning'?'alert':'status')}><strong>{title}</strong>{description&&<div>{description}</div>}</div>
}

const connectionTabLabels = { connection:'srcConnectionSettings', scope:'srcVisibilityScope', advanced:'srcAdvancedLegend' } as const satisfies Record<string, SourcesStringKey>
const maxScopeEntries = 256
const credentialExamples = {
  postgres:'postgresql://reader:{password}@db.example:5432/reporting',
  mysql:'mysql://reader:{password}@db.example:3306/reporting',
  starrocks:'starrocks://reader:{password}@db.example:9030/reporting',
  http:'',
}
const testAdvice: Record<string, SourcesStringKey> = {
  READONLY_ROLE_REQUIRED:'srcReadOnlyPermissionsFailed',
  SOURCE_TIMEOUT:'srcConnectionTimedOut',
  SOURCE_TLS_UNSUPPORTED:'srcTargetTlsUnsupported',
  TARGET_NOT_APPROVED:'srcCheckAllowedTargets',
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
  // Translate at render time; never put `s` in a hook dependency list.
  const { lang } = useI18n()
  const s = (key: SourcesStringKey, params?: Record<string, string | number>) => translateSources(lang, key, params)
  // Client errors carry a dictionary key; show them in the current UI language.
  const errorText = (error: unknown) => { const key = (error as { sourcesKey?: SourcesStringKey } | null)?.sourcesKey; return key ? s(key) : (error as Error)?.message ?? '' }
  const [items, setItems] = useState<SourceDescriptor[]>([]), [cursor, setCursor] = useState<string | null>(null)
  const [listState,setListState]=useState<'loading'|'ready'|'error'>('loading')
  const [listPage,setListPage]=useState(0),[pageStarts,setPageStarts]=useState<(string|undefined)[]>([undefined])
  const [detail, setDetail] = useState<SourceDetail | null>(null), [latest, setLatest] = useState<SourceDetail | null>(null)
  const [savedReadPending,setSavedReadPending] = useState<string|null>(null)
  const [showAddress,setShowAddress] = useState(false)
  const credentialId = useId()
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
  const formBlocked = unknown || savedReadPending !== null
  const inputRef = useRef<HTMLInputElement>(null)
  const focusCredential = useRef(false)
  const surfaceRef = useRef<HTMLElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const previousView = useRef(view)
  const isPage = presentation === 'page'
  useEffect(() => { setShowAddress(false) }, [tab, view, draft.kind, draft.credentialMode])
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
    void client.list().then(page => { if (current) { setItems(page.items); setCursor(page.nextCursor); setListPage(0); setPageStarts([undefined]); setListState('ready') } }).catch(e => { if (current) { setError(errorText(e)); setListState('error') } })
    return () => { current=false; alive.current = false; unsubscribe(); if (inputRef.current) inputRef.current.value = '' }
  }, [client])
  const legacyHttp = detail?.source.kind === 'http'
  const searchTerm = filter.trim().toLocaleLowerCase()
  const visibleItems = items.filter(item => `${item.name} ${item.sourceId} ${item.kind}`.toLocaleLowerCase().includes(searchTerm))
  const dirty = view === 'form' && savedReadPending === null && JSON.stringify(draft) !== JSON.stringify(detail ? fromDetail(detail) : empty())
  function canClose() {
    if (client.getState().pending) { setError(s('srcConnectionOperationPending')); return false }
    if (client.getState().unknownWrite) { setError(s('srcVerifyOperationBeforeClosing')); return false }
    return !dirty || window.confirm(s('srcDiscardChangesAndClose'))
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
  function patchConfig(key: string, value: string | number | undefined) {
    if (publicConfig) patch({config: JSON.stringify({...publicConfig, [key]: value}, null, 2)})
  }
  const discovered = detail && catalog?.sourceId === detail.source.sourceId && catalog.version === detail.source.version ? catalog : undefined
  const discoveryBlock = savedReadPending ? {message:s('srcSavedConfigurationReloadFailed')} as const
    : !publicConfig ? {message:s('srcCorrectPublicConfiguration'),tab:'advanced'} as const
    : !detail ? {message:s('srcSaveBeforeLoadingSchemas'),tab:'connection'} as const
    : !draft.enabled ? {message:s('srcEnableBeforeLoadingSchemas'),tab:'connection'} as const
    : draft.credentialMode!=='retain' ? {message:s('srcSaveChangedCredentials'),tab:'connection'} as const
    : !detail.source.hasCredential ? {message:s('srcMissingConnectionCredentials'),tab:'connection'} as const
    : !detail.source.enabled ? {message:s('srcSaveEnabledStatusFirst'),tab:'connection'} as const
    : publicConfig.database!==('database' in detail.config ? detail.config.database : undefined) ? {message:s('srcSaveDatabaseNameChanges')} as const
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
    setCatalogLoading(directory === undefined ? s('srcLoadingSchemas') : s('srcLoadingTablesOf',{name:directory}))
    try { await loadCatalog(detail,directory) }
    catch (error) {
      if (alive.current) setCatalogError({directory,message:(directory===undefined?s('srcLoadSchemasFailed'):s('srcLoadTablesFailed',{name:directory}))+errorText(error)})
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
    setCatalogLoading(s('srcLoadingTablesOf',{name:directoryToOpen}))
    try {
      const tables=await client.discover(sourceId,version,directoryToOpen)
      if (alive.current) showTables(catalog,{directory:directoryToOpen,result:tables})
    } catch (error) {
      if (alive.current) setCatalogError({directory:directoryToOpen,message:s('srcAutoLoadTablesFailed',{name:directoryToOpen})+errorText(error)})
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
  const bulkLabel=s(filterSelected?'srcBulkSelectedInList':tableSearch?'srcBulkSearchResults':discovered?.tables?.result.truncated?'srcBulkLoadedTables':'srcBulkCurrentSchema')
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
  function reviewSelection(key:'allowedSchemas'|'allowedTables', values:string[]|undefined) {
    if (!values?.length) return null
    const schemas=key==='allowedSchemas'
    return <details className="dc-selection" open>
      <summary>{s(schemas?'srcSelectedSchemasSummary':'srcSelectedTablesSummary',{count:values.length})}</summary>
      <ul aria-label={s(schemas?'srcSelectedSchemasList':'srcSelectedTablesList')}>{values.map(value=><li key={value}>
        <span>{value}{key==='allowedTables'&&blockedTables.has(value)&&<small className="dc-scope-blocked">{s('srcSchemaAccessDenied')}</small>}</span>
        <button type="button" aria-label={s(schemas?'srcRemoveSchemaNamed':'srcRemoveTableNamed',{name:value})} onClick={event=>{
          const button=event.currentTarget
          const item=button.closest('li')
          const next=(item?.nextElementSibling??item?.previousElementSibling)?.querySelector<HTMLButtonElement>('button')
          const fallback=surfaceRef.current?.querySelector<HTMLSelectElement>(`select[aria-label="${s(schemas?'srcSchemaScope':'srcTableVisibility')}"]`)
          ;(next??fallback)?.focus()
          toggleScope(key,value,false)
        }}>×</button>
      </li>)}</ul>
    </details>
  }
  async function operation(action: () => Promise<unknown>, clearSubmittedSecret = false) {
    if (busy) return
    setError(''); setMessage('')
    try { await action() } catch (e) { if (alive.current) setError(errorText(e)) }
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
    if (alive.current) { if (!keepTab) setTab('connection'); setDetail(value); setSavedReadPending(null); setCatalog(undefined); setCatalogError(undefined); setTested(undefined); setFieldError(undefined); setDraft(fromDetail(value)); setLatest(null); setMissing(null); setConfirmDelete(false); setView('form') }
    return value
  }
  async function readLatest(sourceId:string){
    setMissing(null)
    try{const current=await client.detail(sourceId);if(alive.current){setLatest(current);setMessage(s('srcLatestConfigurationLoaded'))}}
    catch(error){if((error as {status?:number}).status!==404)throw error;if(alive.current){setLatest(null);setMissing(sourceId)}}
  }
  async function save() {
    if (legacyHttp || draft.kind === 'http') throw Error(s('srcExistingHttpViewOnly'))
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
    } catch { throw Error(s('srcPublicConfigurationValidation')) }
    for (const key of scopeKeys) {
      const entries=(config as Record<string,unknown>)[key]
      if (Array.isArray(entries)&&entries.length>maxScopeEntries) {
        setTab('scope')
        throw Error(s(key==='allowedSchemas'?'srcTooManySchemas':'srcTooManyTables',{count:entries.length,max:maxScopeEntries}))
      }
    }
    const timeout=(config as Record<string,unknown>).statementTimeoutMs
    if (timeout!==undefined&&(typeof timeout!=='number'||!Number.isInteger(timeout)||timeout<100||timeout>30000)) {
      setTab('advanced')
      throw Error(s('srcTimeoutHint'))
    }
    if (!detail&&!draft.secret) throw Error(s('srcCreationRequiresCredentials'))
    const saved = detail
      ? await client.save(detail.source.sourceId, { expectedVersion: detail.source.version, name: draft.name, config, enabled: draft.enabled,
        ...(draft.credentialMode === 'replace' ? { secret: draft.secret } : draft.credentialMode === 'clear' ? { secret: null } : {}) })
      : await client.create({ sourceId: draft.sourceId, name: draft.name, kind: draft.kind, config, secret: draft.secret, enabled: draft.enabled })
    if (!alive.current) return
    let current:SourceDetail
    try { current=await select(draft.sourceId,true) }
    catch {
      if (alive.current) {
        setSavedReadPending(draft.sourceId)
        setItems(items=>items.some(item=>item.sourceId===saved.sourceId)
          ? items.map(item=>item.sourceId===saved.sourceId?saved:item)
          : [saved,...items])
      }
      throw Error(s('srcSavedConfigurationReloadFailed'))
    }
    await reloadList().catch(()=>{/* The list already shows its own retry state when opened. */})
    const restore=tab==='scope'&&canDiscover?discovered?.tables?.directory:undefined
    if (restore && current.source.enabled && current.source.hasCredential && alive.current) {
      setCatalogLoading(s('srcLoadingSchemas'))
      try { await loadCatalog(current,undefined,restore) }
      catch (error) { if(alive.current)setCatalogError({message:s('srcSavedScopeRefreshFailed')+errorText(error)}) }
      finally { if(alive.current)setCatalogLoading('') }
    }
    if (alive.current) showSavedMessage(current)
    return current
  }
  function showSavedMessage(current:SourceDetail) {
    setMessage(!current.source.enabled?s('srcConnectionSavedDisabled'):!current.source.hasCredential?s('srcSavedConfigureCredentials'):s('srcConnectionSavedActive'))
  }
  async function retrySavedConfiguration(sourceId:string) {
    try {
      const current=await select(sourceId,true)
      if (alive.current) showSavedMessage(current)
    } catch { throw Error(s('srcSavedConfigurationReloadFailed')) }
  }
  function validateConnection() {
    if (!isPage||!publicConfig) return true
    let credentialIssue:string|undefined
    if (draft.kind!=='http'&&(!detail||draft.credentialMode==='replace')) {
      const prefix=(draft.kind==='postgres'?'postgresql':draft.kind)+'://'
      if (!draft.secret.trim()) credentialIssue=s('srcEnterConnectionUrl')
      else if (!draft.secret.toLowerCase().startsWith(prefix)) credentialIssue=s('srcUrlMustStartWith',{prefix})
      else {
        try {
          const address=new URL(draft.secret)
          if (!address.hostname) credentialIssue=s('srcUrlRequiresServer')
          else if (!address.username||!address.password) credentialIssue=s('srcUrlRequiresCredentials')
          else if (!address.pathname||address.pathname==='/') credentialIssue=s('srcUrlRequiresDatabase')
          else if (address.search||address.hash) credentialIssue=s('srcUrlQueryFragmentsForbidden')
          else if (typeof publicConfig.database==='string'&&decodeURIComponent(address.pathname.slice(1))!==publicConfig.database) credentialIssue=s('srcUrlDatabaseMustMatch')
        } catch { credentialIssue=s('srcInvalidConnectionUrl') }
      }
    }
    const issue = !draft.name.trim() ? {field:'name',message:s('srcEnterConnectionName')} as const
      : !detail&&!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(draft.sourceId) ? {field:'sourceId',message:s('srcConnectionIdentifierFormat')} as const
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
    const prefix=saved?s('srcSavedConnectionTestFailed'):s('srcConnectionTestFailed')
    try {
      const checked=await client.test(connection.source.sourceId)
      if (!alive.current) return
      if (checked.ok) {
        setTested(connection.source)
        setMessage(saved?s('srcSavedConnectionTestPassed'):s('srcConnectionTestPassed'))
      } else {
        setMessage('')
        setError(prefix+s(testAdvice[checked.code??'']??'srcCheckConnectionDetails'))
      }
    } catch (error) {
      if(alive.current){setMessage('');setError(prefix+errorText(error))}
    } finally { if (alive.current) setTesting(false) }
  }
  function submit(testAfterSave=false) {
    if (formBlocked||!validateConnection()) return
    setShowAddress(false)
    void operation(async()=>{
      const current=await save()
      if (testAfterSave&&current?.source.enabled&&current.source.hasCredential&&alive.current) await testConnection(current,true)
    },true)
  }
  function backToList() {
    if (busy || dirty && !window.confirm(s('srcDiscardChangesReturnToList'))) return
    setSavedReadPending(null); setTab('connection'); setView('list'); setDetail(null); setDraft(empty()); setTested(undefined); setFieldError(undefined); setLatest(null); setMissing(null); setConfirmDelete(false); setMessage(''); setError(''); setCatalogError(undefined); setSelectedOnly(false)
  }
  const canSaveAndTest = isPage&&tab==='connection'&&draft.enabled&&draft.credentialMode!=='clear'&&(!detail||draft.credentialMode==='replace'||detail.source.hasCredential)
  const canChooseScope = isPage&&tab==='connection'&&!dirty&&canDiscover&&tested?.sourceId===detail?.source.sourceId&&tested?.version===detail?.source.version
  const testBlocked = dirty||legacyHttp||!detail?.source.enabled||!detail.source.hasCredential
  const showTestHint = testBlocked&&!legacyHttp&&!formBlocked&&!busy&&!error&&!message
  const testHelpId = useId()
  const inlineFeedback = isPage && view === 'form'
  const fieldFeedback = (field:NonNullable<typeof fieldError>['field']) => fieldError?.field===field ? <small id={'dc-error-'+field} className="dc-field-error" role="alert">{fieldError.message}</small> : null
  const fieldAttributes = (field:NonNullable<typeof fieldError>['field']) => fieldError?.field===field ? {'aria-invalid':true as const,'aria-describedby':'dc-error-'+field} : {}
  const resultNotice = error
    ? <Notice type="error" title={error}/>
    : message && <Notice type="success" title={message} role="status"/>
  return <div className={`database-connections database-connections--${presentation}`}><section ref={surfaceRef} className="database-connections-surface" role={presentation === 'dialog' ? 'dialog' : undefined} aria-modal={presentation === 'dialog' ? true : undefined} aria-label={s('srcDataConnections')}>
    <header className={`database-connections-header${view === 'form' ? ' database-connections-header--editor' : ''}`}>
      <div>
        {view === 'form' && <button disabled={busy} onClick={backToList}>{s('srcBackToConnections')}</button>}
        <h2 ref={headingRef} tabIndex={inlineFeedback ? -1 : undefined} title={inlineFeedback ? detail?.source.name : undefined}>{view==='list'?s('srcDataConnections'):detail?s('srcEditConnectionTitle',{name:detail.source.name}):s('srcNewDataConnection')}</h2>
        <p>{view==='list'?s('srcManageConnectionsDescription'):s('srcSaveTakesEffect')}</p>
      </div>
      {presentation==='dialog'&&<button disabled={busy} onClick={()=>{if(canClose())onClose()}}>{s('srcCloseDialog')}</button>}
    </header>
    <div className="database-connections-notices">
      {!inlineFeedback && resultNotice}
      {unknown&&<Notice type="warning" showIcon title={s('srcLastWriteUnconfirmed')} description={<div><p>{s('srcReadUnconfirmedHelp',{id:client.getState().unknownSourceId??''})}</p><button disabled={busy} onClick={()=>void operation(()=>readLatest(client.getState().unknownSourceId!))}>{s('srcLoadUnconfirmedConnection',{id:client.getState().unknownSourceId??''})}</button></div>}/>}
      {missing&&<Notice type="info" title={s('srcConnectionConfirmedMissing')} description={<button disabled={busy} onClick={()=>{client.acknowledgeLatest(missing);setDetail(null);setDraft(empty());setMissing(null);setView('form');void operation(()=>reloadList())}}>{s('srcConfirmMissingCreateNew')}</button>}/>}
      {latest&&<Notice type="info" title={s('srcReviewServerConfiguration')} description={<button disabled={busy} onClick={()=>{client.acknowledgeLatest(latest.source.sourceId);setDetail(latest);setDraft(fromDetail(latest));setLatest(null);setView('form')}}>{s('srcUseServerDiscardChanges')}</button>}/>}
    </div>
    {view==='list'?<main className="database-connections-list">
      <div className="database-connections-toolbar"><input ref={searchRef} aria-label={s('srcSearchDataConnections')} placeholder={s('srcSearchCurrentPage')} value={filter} disabled={busy} onChange={event=>setFilter(event.target.value)}/><div className="dc-inline"><button disabled={busy} onClick={()=>void operation(()=>reloadList())}>{s('srcRefreshList')}</button><button className="dc-primary" disabled={busy||unknown} onClick={()=>{setDetail(null);setDraft(empty());setLatest(null);setMissing(null);setConfirmDelete(false);setError('');setMessage('');setView('form')}}>{s('srcNewDataConnection')}</button></div></div>
      {visibleItems.length > 0 && <div className="database-connections-table" role="table" aria-label={s('srcConnectionList')}><div className="database-connections-columns" role="row"><span role="columnheader">{s('srcNameColumn')}</span><span role="columnheader">{s('srcTypeColumn')}</span><span role="columnheader">{s('srcStatusColumn')}</span><span role="columnheader">{s('srcCredentialsColumn')}</span><span role="columnheader">{s('srcActionsColumn')}</span></div>
        {visibleItems.map(item=><div className="database-connection-row" role="row" key={item.sourceId}><div role="cell"><button className="database-connection-name" disabled={busy} onClick={()=>void operation(()=>select(item.sourceId))}>{item.name}</button><small>{item.sourceId}</small></div><span role="cell">{item.kind==='postgres'?'PostgreSQL':item.kind==='mysql'?'MySQL':item.kind==='starrocks'?'StarRocks':s('srcHttpReadOnly')}</span><span role="cell"><span className={item.enabled?"dc-badge dc-badge--enabled":"dc-badge"}>{item.enabled?s('srcStatusEnabled'):s('srcStatusDisabled')}</span></span><span role="cell">{item.hasCredential?s('srcStatusConfigured'):s('srcStatusNotConfigured')}</span><span role="cell"><button aria-label={s(item.kind==='http'?'srcViewConnectionNamed':'srcEditConnectionNamed',{name:item.name})} disabled={busy} onClick={()=>void operation(()=>select(item.sourceId))}>{s(item.kind==='http'?'srcView':'srcEdit')}</button></span></div>)}
      </div>}
      {listState==='loading'&&<p className="database-connections-empty" role="status">{s('srcLoadingDataConnections')}</p>}
      {listState==='error'&&<p className="database-connections-empty">{s('srcConnectionListLoadFailed')}</p>}
      {listState==='ready'&&!visibleItems.length&&<div className="database-connections-empty"><p>{searchTerm?s('srcNoMatchingConnections'):s('srcNoConnectionsConfigured')}</p>{searchTerm&&<button onClick={()=>setFilter('')}>{s('srcClearFilters')}</button>}</div>}
      <nav className="dc-pagination" aria-label={s('srcDataConnectionPagination')}><button aria-label={s('srcPreviousConnectionsPage')} disabled={busy||unknown||listPage===0} onClick={()=>changeListPage(listPage-1)}>{s('srcPreviousPage')}</button><span role="status">{s('srcPageNumber',{page:listPage+1})}</span><button aria-label={s('srcNextConnectionsPage')} disabled={busy||unknown||!cursor} onClick={()=>changeListPage(listPage+1)}>{s('srcNextPage')}</button></nav>
    </main>:<main className="database-connections-form">
      {isPage&&!legacyHttp&&<nav role="tablist" aria-label={s('srcDataConnectionCategories')} className="dc-category-tabs" onKeyDown={navigateTabs}>
        {connectionTabs.map(category=><button key={category} type="button" role="tab" id={`dc-tab-${category}`} aria-controls={`dc-panel-${category}`} aria-selected={tab===category} tabIndex={tab===category?0:-1} disabled={busy} onClick={()=>setTab(category)}>{s(connectionTabLabels[category])}</button>)}
      </nav>}
      {legacyHttp&&<Notice type="info" showIcon title={s('srcSupportedConnectionTypes')}/>}
      {dirty&&!inlineFeedback&&<p className="database-connections-dirty" role="status">{s('srcUnsavedChangesBeforeLeaving')}</p>}
      <div className="dc-category-panel" id="dc-panel-connection" role={isPage&&!legacyHttp?'tabpanel':undefined} aria-labelledby={isPage&&!legacyHttp?'dc-tab-connection':undefined} hidden={isPage&&tab!=='connection'}>
      <fieldset disabled={busy||formBlocked||legacyHttp}><legend>{s('srcBasicInformation')}</legend><div className="database-connections-grid">
        <label>{s('srcNameColumn')}<input {...fieldAttributes('name')} aria-label={s('srcConnectionName')} disabled={busy||formBlocked||legacyHttp} value={draft.name} maxLength={200} placeholder={s('srcConnectionNameExample')} onChange={event=>patch({name:event.target.value})}/>{fieldFeedback('name')}</label>
        <label>{s('srcConnectionIdentifier')}<input {...fieldAttributes('sourceId')} aria-label={s('srcConnectionIdentifier')} disabled={!!detail||busy||formBlocked||legacyHttp} value={draft.sourceId} maxLength={64} placeholder={s('srcConnectionIdentifierExample')} onChange={event=>patch({sourceId:event.target.value})}/>{fieldFeedback('sourceId')}</label>
        <label>{s('srcConnectionConnector')}<select aria-label={s('srcConnectionConnector')} disabled={!!detail||busy||formBlocked} value={draft.kind} onChange={event=>patch({kind:event.target.value as SourceKind})}>{legacyHttp&&<option value="http">{s('srcHttpJsonReadOnly')}</option>}<option value="postgres">PostgreSQL</option><option value="mysql">MySQL</option><option value="starrocks">StarRocks</option></select></label>
        <div className="database-connections-enabled"><label className="dc-check"><input type="checkbox" aria-label={s('srcEnableDataConnection')} disabled={busy||formBlocked||legacyHttp} checked={draft.enabled} onChange={event=>patch({enabled:event.target.checked})}/>{s('srcEnableDataConnection')}</label></div>
      </div></fieldset>
      <fieldset disabled={busy||formBlocked||legacyHttp}><legend>{s('srcCredentialsColumn')}</legend><p>{s('srcEncryptedCredentialsNotice')}</p>
        {detail&&!legacyHttp&&<label>{s('srcCredentialActions')}<select aria-label={s('srcCredentialActions')} value={draft.credentialMode} disabled={busy||formBlocked} onChange={event=>patch({credentialMode:event.target.value as Draft['credentialMode'],secret:''})}><option value="retain">{s('srcRetainCredentials')}{s(detail.source.hasCredential?'srcConfiguredSuffix':'srcNotConfiguredSuffix')}</option><option value="replace">{s('srcReplaceCredentials')}</option><option value="clear">{s('srcClearConnectionCredentials')}</option></select></label>}
        {!legacyHttp&&(!detail||draft.credentialMode==='replace')&&<div className="dc-credentials">
          <label htmlFor={credentialId}>{s('srcDatabaseConnectionUrl')}</label>
          <div className="dc-inline dc-credential-input">
            <input {...fieldAttributes('secret')} id={credentialId} ref={inputRef} aria-label={s('srcConnectionCredentials')} type={showAddress?'text':'password'} autoComplete="new-password" spellCheck={false} autoCapitalize="none" value={draft.secret} placeholder={s('srcReadOnlyUrlPlaceholder')} onChange={event=>{if(!event.target.value)setShowAddress(false);patch({secret:event.target.value})}}/>
            <button type="button" disabled={!draft.secret} onClick={()=>setShowAddress(shown=>!shown)}>{s(showAddress?'srcHideAddress':'srcShowAddress')}</button>
          </div>
          <small>{s('srcExamplePrefix')}<code>{credentialExamples[draft.kind].replace('{password}',s('srcPasswordWord'))}</code></small>{fieldFeedback('secret')}
        </div>}
      </fieldset>
      </div>
      <div className="dc-category-panel" id="dc-panel-scope" role={isPage&&!legacyHttp?'tabpanel':undefined} aria-labelledby={isPage&&!legacyHttp?'dc-tab-scope':undefined} hidden={isPage&&tab!=='scope'}>
      <fieldset disabled={busy||formBlocked||legacyHttp}><legend>{s('srcVisibleSchemasAndTables')}</legend><p>{s('srcSchemaTableScopeIntersection')}</p>
        {!legacyHttp&&<label>{s('srcOptionalDatabaseName')}<input aria-label={s('srcDatabaseName')} disabled={!publicConfig||busy||formBlocked} value={typeof publicConfig?.database==='string'?publicConfig.database:''} onChange={event=>{if(!publicConfig)return;const next={...publicConfig};const value=event.target.value.trim();if(value)next.database=value;else delete next.database;patch({config:JSON.stringify(next,null,2)})}}/><small>{s('srcDatabaseMustMatchCredentials')}</small></label>}
        <div className="dc-scope-modes">
        {!legacyHttp&&<label>{s('srcSchemaScope')}<select aria-label={s('srcSchemaScope')} disabled={!publicConfig||busy||formBlocked} value={publicConfig&&Object.hasOwn(publicConfig,'allowedSchemas')?'selected':'all'} onChange={event=>{if(!publicConfig)return;const next={...publicConfig};if(event.target.value==='selected')next.allowedSchemas=[];else delete next.allowedSchemas;patch({config:JSON.stringify(next,null,2)});if(event.target.value==='selected'&&!discovered&&canDiscover)void operation(()=>discover())}}><option value="all">{s('srcAllSchemasRestricted')}</option><option value="selected">{s('srcSelectedSchemasOnly')}</option></select></label>}
        {!legacyHttp&&<label>{s('srcTableVisibility')}<select aria-label={s('srcTableVisibility')} disabled={!publicConfig||busy||formBlocked} value={publicConfig&&Object.hasOwn(publicConfig,'allowedTables')?'selected':'all'} onChange={event=>{const value=event.target.value;if(!publicConfig)return;const next={...publicConfig};if(value==='selected')next.allowedTables=[];else delete next.allowedTables;patch({config:JSON.stringify(next,null,2)});if(value==='selected'&&!discovered&&canDiscover)void operation(()=>discover())}}><option value="selected">{s('srcSelectedTablesOnly')}</option><option value="all">{s('srcAllReadableTables')}</option></select></label>}
        </div>
        {!legacyHttp&&<p>{selectedDirectories ? s('srcSelectedSchemaCount',{count:selectedDirectories.length}) : s('srcAllSchemas')}{s('srcListSeparator')}{selectedTables ? s(selectedDirectories?'srcTableCount':'srcSelectedTableCount',{count:selectedTables.length}) : s('srcAllReadableTables')}</p>}
        {!legacyHttp&&scopeChanged&&<button type="button" onClick={restoreScope}>{s('srcRestoreSavedSchemasAndTables')}</button>}
        {directoryLimit&&<p role="status">{s('srcSchemaLimitReached',{max:maxScopeEntries})}</p>}
        {tableLimit&&<p role="status">{s('srcTableLimitReached',{max:maxScopeEntries})}</p>}
        {!legacyHttp&&(selectedDirectories?.length===0||selectedTables?.length===0)&&
          <p className="dc-scope-empty" role="status">{s(selectedDirectories?.length===0?'srcNoSchemaSelected':'srcNoTableSelected')}</p>}
        {!legacyHttp&&!!selectedDirectories?.length&&blockedTables.size>0&&
          <p className="dc-scope-empty" role="status">{s('srcBlockedTables',{count:blockedTables.size})}</p>}
        {!legacyHttp&&reviewSelection('allowedSchemas',selectedDirectories)}
        {!legacyHttp&&reviewSelection('allowedTables',selectedTables)}
        {!legacyHttp&&<section className="dc-discovery" aria-label={s('srcDiscoverSchemasAndTables')}>
          <p>{s('srcLoadSavedScopeHelp')}</p>
          <button type="button" disabled={!canDiscover} onClick={()=>void operation(()=>discover())}>{discovered?s('srcReloadSchemasAndTables'):s('srcLoadSchemasAndTables')}</button>
          {catalogLoading&&<p role="status">{catalogLoading}</p>}
          {catalogError&&<Notice type="error" title={catalogError.message} description={canDiscover&&<div className="dc-inline">
            <button type="button" onClick={()=>void operation(()=>discover(catalogError.directory))}>{catalogError.directory===undefined?s('srcRetryLoadingSchemas'):s('srcRetryLoadingTables')}</button>
            <button type="button" onClick={()=>void operation(()=>{
            setCatalogError(undefined)
            return testConnection(detail!)
          })}>{s('srcTestConnectionViewDetails')}</button></div>}/>}
          {discoveryBlock&&<div className="dc-directory-warning">
            <p>{discoveryBlock.message}</p>
            {isPage&&discoveryTab&&<button type="button" onClick={()=>{
              setTab(discoveryTab)
              if(discoveryTab==='connection'&&detail&&!detail.source.hasCredential&&draft.credentialMode==='retain') {
                focusCredential.current=true
                patch({credentialMode:'replace'})
              } else surfaceRef.current?.querySelector<HTMLButtonElement>('#dc-tab-'+discoveryTab)?.focus()
            }}>{s('srcGoToTab',{tab:s(connectionTabLabels[discoveryTab])})}</button>}
          </div>}
          {discovered&&<>
            {discovered.directories.truncated&&<p role="status">{s('srcSchemaDisplayLimit')}</p>}
            {!discovered.directories.items.length&&<p>{s('srcNoSchemasAvailable')}</p>}
            <div className="dc-catalog-columns">
            {discovered.directories.items.length>0&&<details className="dc-picker" open>
              <summary>{discovered.tables ? s('srcSchemaNamed',{name:discovered.tables.directory}) : s('srcSearchOrSelectSchema')}</summary>
              <div className="dc-search-row"><label>{s('srcSearchSchemas')}<input aria-label={s('srcSearchSchemas')} type="search" value={directoryFilter} onChange={event=>setDirectoryFilter(event.target.value)}/></label>
              {directoryFilter&&<button type="button" onClick={event=>{
                setDirectoryFilter('')
                event.currentTarget.closest('details')?.querySelector<HTMLInputElement>('input[type="search"]')?.focus()
              }}>{s('srcClearSchemaSearch')}</button>}</div>
              {!matchingDirectories?.length&&<p className="dc-filter-empty" role="status">{s('srcNoMatchingSchemas')}</p>}
              <ul aria-label={s('srcAvailableSchemas')}>{matchingDirectories?.map(directory=><li key={directory}>
              {selectedDirectories ? <label className="dc-check"><input type="checkbox" aria-label={s('srcAllowSchemaNamed',{name:directory})} checked={selectedDirectories.includes(directory)} disabled={directoryLimit&&!selectedDirectories.includes(directory)} onChange={event=>toggleScope('allowedSchemas',directory,event.target.checked)}/>{directory}</label> : <span>{directory}</span>}
              <button type="button" aria-current={discovered.tables?.directory===directory?true:undefined} disabled={!canDiscover} onClick={()=>void operation(()=>discover(directory))}>{s('srcBrowseTablesOf',{name:directory})}</button>
            </li>)}</ul>
            </details>}
            {discovered.tables&&<details key={discovered.tables.directory} className="dc-picker" aria-label={s('srcTablesInSchemaAria',{name:discovered.tables.directory})} open>
              <summary>{s('srcTablesOf',{name:discovered.tables.directory})}{selectedTables&&s('srcSelectedCountSuffix',{count:availableTables.filter(table=>table.checked).length})}</summary>
              {publicConfig&&!selectedDirectories&&<button type="button" disabled={!canDiscover} onClick={event=>{
                patch({config:JSON.stringify({...publicConfig,allowedSchemas:[tableDirectory]},null,2)})
                event.currentTarget.closest('details')?.querySelector('summary')?.focus()
              }}>{s('srcAllowOnlyThisSchema')}</button>}
              {selectedDirectories&&!selectedDirectories.includes(discovered.tables.directory)&&<div className="dc-directory-warning">
                <p>{s('srcUnselectedSchemaWarning')}</p>
                {selectedDirectories.length>=maxScopeEntries
                  ? <small>{s('srcMaxSchemasRemoveFirst',{max:maxScopeEntries})}</small>
                  : <>
                    <button type="button" disabled={!canDiscover} onClick={event=>{
                      toggleScope('allowedSchemas',discovered.tables!.directory,true)
                      event.currentTarget.closest('details')?.querySelector('summary')?.focus()
                    }}>{s('srcAllowThisSchema')}</button>
                    {!selectedTables&&<small>{s('srcAllowSchemaTablesNotice')}</small>}
                  </>}
              </div>}
              {discovered.tables.result.truncated&&<p role="status">{s('srcTableDisplayLimit')}</p>}
              {!discovered.tables.result.items.length&&<p>{s('srcNoTablesInSchema')}</p>}
              {discovered.tables.result.items.length>0&&<div className="dc-search-row"><label>{s('srcSearchTables')}<input aria-label={s('srcSearchTables')} type="search" value={catalogFilter} onChange={event=>setCatalogFilter(event.target.value)}/></label>
              {catalogFilter&&<button type="button" onClick={event=>{
                setCatalogFilter('')
                event.currentTarget.closest('details')?.querySelector<HTMLInputElement>('input[type="search"]')?.focus()
              }}>{s('srcClearTableSearch')}</button>}</div>}
              {selectedTables&&discovered.tables.result.items.length>0&&<label className="dc-check"><input type="checkbox" aria-label={s('srcShowSelectedTablesOnly')} checked={selectedOnly} onChange={event=>setSelectedOnly(event.target.checked)}/>{s('srcShowSelectedTablesOnly')}</label>}
              {publicConfig&&!selectedTables&&discovered.tables.result.items.length>0&&<div className="dc-directory-warning">
                <p>{s('srcAllAllowedTablesHelp')}</p>
                <button type="button" disabled={!canDiscover} onClick={event=>{
                  patch({config:JSON.stringify({...publicConfig,allowedTables:[]},null,2)})
                  event.currentTarget.closest('details')?.querySelector<HTMLInputElement>('input[type="search"]')?.focus()
                }}>{s('srcSelectIndividualTables')}</button>
              </div>}
              {(tableSearch||filterSelected)&&!matchingTables.length&&<p className="dc-filter-empty" role="status">{filterSelected?s('srcNoMatchingSelectedTables'):s('srcNoMatchingTables')}</p>}
              {bulkTables&&selectedTables&&<div className="dc-bulk-tables">
                <button type="button" disabled={!canDiscover||!tablesToAdd.length||exceedsTableLimit} onClick={()=>setTableSelection([...selectedTables,...tablesToAdd])}>{s('srcSelectBulk',{label:bulkLabel,count:bulkTables.length})}</button>
                <button type="button" disabled={!canDiscover||!tablesToRemove.size} onClick={()=>setTableSelection(selectedTables.filter(id=>!tablesToRemove.has(id)))}>{s('srcUnselectBulk',{label:bulkLabel,count:bulkTables.length})}</button>
                <small role="status">{s('srcBulkCheckedCount',{checked:bulkTables.length-tablesToAdd.length,total:bulkTables.length})}</small>
                {exceedsTableLimit&&<small>{s(tableSearch?'srcTableLimitNarrowSearch':'srcTableLimitSearchFirst',{max:maxScopeEntries})}</small>}
              </div>}
              <ul aria-label={s('srcAvailableTables')}>{matchingTables.map(({name,id,alias,checked})=><li key={id}>{selectedTables
                ? <label className="dc-check"><input type="checkbox" aria-label={s('srcAllowTableNamed',{name:id})} checked={checked} disabled={tableLimit&&!checked} onChange={event=>toggleScope('allowedTables',id,event.target.checked,alias)}/>{name}</label>
                : <span>{name}</span>}</li>)}</ul>
            </details>}
            </div>
          </>}
        </section>}
        {(selectedDirectories||selectedTables)&&<details className="dc-manual-scope" open={!isPage}><summary>{s('srcEnterScopeManually')}</summary>
        {!legacyHttp&&publicConfig&&Object.hasOwn(publicConfig,'allowedSchemas')&&<label>{s('srcAllowedSchemas')}<textarea aria-label={s('srcAllowedSchemas')} disabled={busy||formBlocked} rows={3} spellCheck={false} placeholder={draft.kind==='postgres'?'sales':'warehouse'} value={Array.isArray(publicConfig.allowedSchemas)?publicConfig.allowedSchemas.map(String).join('\n'):''} onChange={event=>patch({config:JSON.stringify({...publicConfig,allowedSchemas:event.target.value.split(/[\n,，]/)},null,2)})}/><small>{s('srcManualSchemaScopeHelp')}</small></label>}
        {!legacyHttp&&publicConfig&&Object.hasOwn(publicConfig,'allowedTables')&&<label>{s('srcAllowedTables')}<textarea aria-label={s('srcAllowedTables')} disabled={busy||formBlocked} rows={4} spellCheck={false} placeholder={'public.orders\npublic.order_items'} value={Array.isArray(publicConfig.allowedTables)?publicConfig.allowedTables.map(String).join('\n'):''} onChange={event=>patch({config:JSON.stringify({...publicConfig,allowedTables:event.target.value.split(/[\n,，]/)},null,2)})}/><small>{s('srcManualTableScopeHelp')}</small></label>}
        </details>}
      </fieldset>
      </div>
      <div className="dc-category-panel" id="dc-panel-advanced" role={isPage&&!legacyHttp?'tabpanel':undefined} aria-labelledby={isPage&&!legacyHttp?'dc-tab-advanced':undefined} hidden={isPage&&tab!=='advanced'}>
      <fieldset disabled={busy||formBlocked||legacyHttp}><legend>{s('srcAdvancedLegend')}</legend><div className="database-connections-grid">
        <label>{s('srcTimezone')}<input aria-label={s('srcTimezone')} disabled={!publicConfig||busy||formBlocked||legacyHttp} placeholder={s('srcTimezonePlaceholder')} value={typeof publicConfig?.timezone==='string'?publicConfig.timezone:''} onChange={event=>patchConfig('timezone',event.target.value)}/></label>
        <label>{s('srcMaxRows')}<input aria-label={s('srcMaxRowsAria')} disabled={!publicConfig||busy||formBlocked||legacyHttp} type="number" min={1} max={10000} step={1} placeholder="1000" value={typeof publicConfig?.maxRows==='number'?publicConfig.maxRows:''} onChange={event=>patchConfig('maxRows',event.target.value===''?undefined:Number(event.target.value))}/></label>
        {draft.kind!=='http'&&<label>{s('srcTimeout')}<input aria-label={s('srcTimeoutAria')} title={s('srcTimeoutHint')} disabled={!publicConfig||busy||formBlocked||legacyHttp} type="number" min={100} max={30000} step={100} placeholder="5000" value={typeof publicConfig?.statementTimeoutMs==='number'?publicConfig.statementTimeoutMs:''} onChange={event=>patchConfig('statementTimeoutMs',event.target.value===''?undefined:Number(event.target.value))}/></label>}
      </div><details><summary>{s('srcAdvancedConfigurationDetails')}</summary><label>{s('srcPublicConfigurationJson')}<textarea aria-label={s('srcPublicConfigurationJson')} disabled={busy||formBlocked||legacyHttp} rows={7} spellCheck={false} value={draft.config} onChange={event=>patch({config:event.target.value})}/></label><p>{s('srcPublicConfigurationOnlyHelp')}</p></details></fieldset>
      </div>
      {detail&&(!isPage||tab==='connection')&&<section className="database-connections-danger" aria-label={s('srcDeleteConnection')}><h3>{s('srcDeleteConnection')}</h3><p>{s('srcDeletionPermanentWarning')}</p><label className="dc-check"><input type="checkbox" aria-label={s('srcConfirmConnectionDeletion')} disabled={busy||formBlocked||legacyHttp} checked={confirmDelete} onChange={event=>setConfirmDelete(event.target.checked)}/>{s('srcConfirmDeletionRetainTombstone')}</label><button className="dc-danger" disabled={busy||formBlocked||legacyHttp||!confirmDelete} onClick={()=>void operation(async()=>{await client.remove(detail.source.sourceId,detail.source.version);if(!alive.current)return;setDetail(null);setDraft(empty());setView('list');await reloadList()})}>{s('srcDeleteConnection')}</button></section>}
      <footer className="database-connections-actions">
        {testing&&<Notice type="info" title={s('srcTestingConnection')}/>}
        {inlineFeedback && (resultNotice || (dirty && <p className="database-connections-dirty" role="status">{s('srcUnsavedChangesNotice')}</p>))}
        {showTestHint&&<p id={testHelpId} className="dc-test-help">{s('srcPrepareConnectionTest')}</p>}
        <div>
          {canSaveAndTest&&<button className="dc-primary" disabled={busy||formBlocked||legacyHttp} onClick={()=>submit(true)}>{s('srcSaveAndTest')}</button>}
          <button className={canSaveAndTest?undefined:'dc-primary'} disabled={busy||formBlocked||legacyHttp} onClick={()=>submit()}>{s('srcSaveConnection')}</button>
          {canChooseScope&&<button disabled={busy||formBlocked} onClick={()=>{setTab('scope');if(!discovered)void operation(()=>discover())}}>{s('srcSelectVisibilityScope')}</button>}
          <button disabled={busy||formBlocked||testBlocked} aria-describedby={showTestHint?testHelpId:undefined} onClick={()=>void operation(()=>testConnection(detail!))}>{s('srcTestConnection')}</button>
          {dirty&&<button disabled={busy||formBlocked} onClick={()=>{setShowAddress(false);setDraft(detail?fromDetail(detail):empty());setLatest(null);setFieldError(undefined);setError('')}}>{s('srcDiscardChanges')}</button>}
        </div>{(detail||savedReadPending||unknown&&draft.sourceId)&&<button disabled={busy} onClick={()=>void operation(()=>savedReadPending?retrySavedConfiguration(savedReadPending):readLatest(detail?.source.sourceId??draft.sourceId))}>{s('srcLoadReviewLatestConfiguration')}</button>}
      </footer>
    </main>}
  </section></div>
}
