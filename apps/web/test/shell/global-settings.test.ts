import {afterEach, expect, test, vi} from 'vitest'
import {act, createElement as h, StrictMode} from 'react'
import {createRoot, type Root} from 'react-dom/client'
import {GlobalSettingsPanel} from '../../src/shell/GlobalSettingsPanel'
import {createGlobalSettingsClient, type GlobalSettingsClient, type GlobalSettingsRequest} from '../../src/shell/global-settings-client'
import type {AdminGlobalConfig, SaveGlobalConfigRequest} from '../../../../packages/web-contracts/src/settings'

;(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true

const initial = (): AdminGlobalConfig => ({revision: 3, entries: [{id: 'primary', kind: 'chat', providerId: 'openai', label: 'Original', model: 'model-a', baseUrl: 'https://example.test/v1', enabled: true, hasKey: true}], defaults: {chat: 'primary'}, keyStorageAvailable: true, providerCatalog: [
  {id: 'openai', label: 'OpenAI', kinds: ['chat'], models: ['model-a', 'model-b'], defaultBaseUrl: 'https://example.test/v1', available: true},
  {id: 'codex', label: 'Codex CLI', kinds: ['chat'], models: [], defaultBaseUrl: '', available: false, unavailableReason: '仅桌面可用'},
  {id: 'image', label: 'Image Provider', kinds: ['image_generation'], models: ['image-model'], defaultBaseUrl: 'https://images.test/v1', available: true},
]})
const deferred = <T,>() => {let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no}); return {promise, resolve, reject}}
const roots: Root[] = []
const requestFrom = (run: (path: string, method?: string, body?: unknown) => Promise<unknown>): GlobalSettingsRequest => run as GlobalSettingsRequest
async function mount(client: GlobalSettingsClient, onClose = () => {}) {const host = document.createElement('div'); document.body.append(host); const root = createRoot(host); roots.push(root); await act(async () => root.render(h(GlobalSettingsPanel, {client, onClose}))); return {root, host}}
test('browser navigation warns for unsaved global configuration and releases the guard on unmount',async()=>{
 const {root}=await mount(createGlobalSettingsClient(requestFrom(async()=>initial())))
 const unload=()=>{const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);return event.defaultPrevented}
 expect(unload()).toBe(false)
 await change('配置名称','Unsaved change')
 expect(unload()).toBe(true)
 await act(async()=>root.unmount());roots.splice(roots.indexOf(root),1)
 expect(unload()).toBe(false)
})
function button(text: string, host: ParentNode = document) {const found = [...host.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === text); expect(found, text).toBeDefined(); return found!}
function input(label: string) {const found = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`); expect(found, label).not.toBeNull(); return found!}
async function click(text: string) {await act(async () => button(text).click())}
async function choose(label: string, text: string) {
 const node=document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!
 expect(node,label).not.toBeNull()
 const option=[...node.options].find(item=>item.textContent===text)
 expect(option,text).toBeDefined()
 if(option!.disabled)return
 await act(async()=>{Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value')!.set!.call(node,option!.value);node.dispatchEvent(new Event('change',{bubbles:true}))})
}
async function change(label: string, value: string) {await act(async () => {const node = input(label); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(node, value); node.dispatchEvent(new Event('input', {bubbles: true}))})}
async function submit() {await act(async () => document.querySelector('form[aria-label="全局配置表单"]')!.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true})))}
afterEach(async () => {await act(async () => {for (const root of roots.splice(0)) root.unmount()}); document.body.innerHTML = ''; localStorage.clear(); sessionStorage.clear()})

test('shows saved key presence without returning credentials and obtains provider options from the catalog', async () => {
  await mount(createGlobalSettingsClient(requestFrom(async () => initial())))
  expect(input('配置名称').value).toBe('Original')
  expect(input('API 密钥').type).toBe('password')
  expect(input('API 密钥').value).toBe('')
  expect(document.body.textContent).toContain('已保存密钥')
  await choose('服务商', 'Codex CLI（当前 Web 不可用）')
  expect(input('模型标识').value).toBe('model-a')
  expect(document.querySelector<HTMLSelectElement>('select[aria-label="服务商"]')?.value).toBe('openai')
  expect(document.querySelector('datalist')?.textContent).toContain('model-b')
})

test.each([400, 409, 503])('HTTP %i keeps non-secret edits, clears submitted keys, and never reflects server error text', async status => {
  let calls = 0; let sent: SaveGlobalConfigRequest | undefined
  await mount(createGlobalSettingsClient(requestFrom(async (_path, method = 'GET', body) => {if (method === 'GET') return initial(); calls++; sent = body as SaveGlobalConfigRequest; throw Object.assign(new Error('server-secret-echo'), {status})})))
  await change('配置名称', 'Retained draft'); await change('API 密钥', 'one-use-secret'); await submit()
  expect(calls).toBe(1)
  expect(sent?.patch.upserts?.[0].apiKey).toBe('one-use-secret')
  expect(input('API 密钥').value).toBe('')
  expect(input('配置名称').value).toBe('Retained draft')
  expect(document.querySelector('[role="alert"]')).not.toBeNull()
  expect(document.body.textContent).not.toContain('server-secret-echo')
  expect(localStorage.length + sessionStorage.length).toBe(0)
})

test('a conflict reload preserves the draft while accepting the new revision without deleting another administrator’s entry', async () => {
  let saved = initial(); const writes: SaveGlobalConfigRequest[] = []
  await mount(createGlobalSettingsClient(requestFrom(async (_path, method = 'GET', body) => {
    if (method === 'GET') return structuredClone(saved)
    writes.push(body as SaveGlobalConfigRequest)
    if (writes.length === 1) {saved = {...saved, revision: 4, entries: [...saved.entries, {...saved.entries[0], id: 'remote', label: 'Remote entry'}]}; throw Object.assign(new Error('conflict'), {status: 409})}
    saved = {...saved, revision: 5, entries: saved.entries.map(entry => entry.id === 'primary' ? {...entry, label: 'My draft'} : entry)}; return saved
  })))
  await change('配置名称', 'My draft'); await submit()
  expect(button('保存配置').disabled).toBe(true)
  await click('读取最新配置')
  expect(input('配置名称').value).toBe('My draft')
  expect(document.body.textContent).toContain('Remote entry')
  await submit()
  expect(writes[1].expectedRevision).toBe(4)
  expect(writes[1].patch.removes).toBeUndefined()
  expect(writes[1].patch.upserts?.map(entry => entry.id)).toEqual(['primary'])
})

test('clearing a stored key requires its own confirmation and sends only clearKey', async () => {
  const writes: SaveGlobalConfigRequest[] = []
  await mount(createGlobalSettingsClient(requestFrom(async (_path, method = 'GET', body) => {if (method === 'GET') return initial(); writes.push(body as SaveGlobalConfigRequest); return {...initial(), revision: 4, entries: [{...initial().entries[0], hasKey: false}]}})))
  await click('清空密钥')
  expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain('保存')
  expect(writes).toHaveLength(0)
  await click('确认清空密钥'); await submit()
  expect(writes[0].patch.upserts?.[0]).toMatchObject({clearKey: true})
  expect(writes[0].patch.upserts?.[0]).not.toHaveProperty('apiKey')
  expect(writes[0].patch.upserts?.[0]).not.toHaveProperty('hasKey')
  expect(document.body.textContent).toContain('未保存密钥')
})

test('an unknown write stays blocked across close and reopen, and reading the latest never replays it', async () => {
  let writes = 0
  const client = createGlobalSettingsClient(requestFrom(async (_path, method = 'GET') => {if (method === 'PUT') {writes++; throw new Error('connection lost')} return initial()}))
  const first = await mount(client)
  await change('配置名称', 'Uncertain'); await submit()
  expect(button('保存配置').disabled).toBe(true)
  await act(async () => first.root.unmount()); roots.splice(roots.indexOf(first.root), 1); first.host.remove()
  await mount(client)
  expect(button('保存配置').disabled).toBe(true)
  expect(document.body.textContent).toContain('无法确认')
  await click('读取最新配置')
  expect(writes).toBe(1)
  await change('配置名称', 'Reviewed edit')
  expect(button('保存配置').disabled).toBe(false)
})

test('same-turn submits and remounts share the pending client operation and ignore the old component result', async () => {
  const pending = deferred<AdminGlobalConfig>(); let writes = 0; let reads = 0
  const client = createGlobalSettingsClient(requestFrom(async (_path, method = 'GET') => {if (method === 'PUT') {writes++; return pending.promise} reads++; return reads === 1 ? initial() : {...initial(), revision: 4, entries: [{...initial().entries[0], label: 'Authoritative reload'}]}}))
  const first = await mount(client)
  await change('配置名称', 'Submitting')
  await act(async () => {const form = document.querySelector('form')!; form.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true})); form.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}))})
  expect(writes).toBe(1)
  await act(async () => first.root.unmount()); roots.splice(roots.indexOf(first.root), 1); first.host.remove()
  await mount(client)
  expect(reads).toBe(1)
  await act(async () => pending.resolve({...initial(), revision: 4, entries: [{...initial().entries[0], label: 'Old component response'}]}))
  await vi.waitFor(() => expect(input('配置名称').value).toBe('Authoritative reload'))
  expect(document.body.textContent).not.toContain('Old component response')
  expect(writes).toBe(1)
})

test('saved configuration checks never claim connectivity and omit unsaved API keys', async () => {
  const calls: unknown[] = []
  await mount(createGlobalSettingsClient(requestFrom(async (path, method = 'GET', body) => {if (method === 'GET') return initial(); calls.push({path, body}); return {revision: 3, configuration: 'valid', checkedEntries: 1, secrets: 'readable', connection: 'not_run'}})))
  await change('API 密钥', 'unsubmitted-secret'); await click('检查已保存配置')
  expect(calls).toEqual([{path: '/api/v1/admin/config/check', body: {expectedRevision: 3}}])
  expect(document.querySelector('[role="status"]')?.textContent).toContain('未进行模型或服务连通测试')
  expect(document.body.textContent).not.toContain('连接成功')
})

test('adding an image configuration, enabling it, and selecting its default produce one coherent save', async () => {
  let submitted: SaveGlobalConfigRequest | undefined
  await mount(createGlobalSettingsClient(requestFrom(async (_path, method = 'GET', body) => {if (method === 'GET') return initial(); submitted = body as SaveGlobalConfigRequest; return {...initial(), revision: 4}})))
  await click('添加配置'); await choose('配置类型', '图像生成'); await change('配置名称', 'Images')
  expect(input('模型标识').value).toBe('image-model')
  expect(input('服务地址').value).toBe('https://images.test/v1')
  await act(async () => document.querySelector<HTMLInputElement>('[aria-label="启用配置"]')!.click())
  await choose('默认图像生成配置', 'Images'); await submit()
  const createdId = submitted?.patch.upserts?.[0].id
  expect(createdId).toBeTruthy()
  expect(submitted?.patch.defaults).toMatchObject({image_generation: createdId})
  expect(submitted?.patch.upserts?.[0]).toMatchObject({id: createdId, kind: 'image_generation', providerId: 'image', label: 'Images', enabled: true})
})

test('changing the type of a draft default cancels its now-invalid default reference', async () => {
  let submitted: SaveGlobalConfigRequest | undefined
  await mount(createGlobalSettingsClient(requestFrom(async (_path, method = 'GET', body) => {if (method === 'GET') return initial(); submitted = body as SaveGlobalConfigRequest; return {...initial(), revision: 4}})))
  await click('添加配置'); await change('配置名称', 'Moving default')
  await act(async () => document.querySelector<HTMLInputElement>('[aria-label="启用配置"]')!.click())
  await choose('默认对话配置', 'Moving default'); await choose('配置类型', '图像生成'); await submit()
  expect(submitted?.patch.defaults).toEqual({chat: null})
})

test('rotation confirms use of the server key and preserves an unrelated non-secret draft', async () => {
  const calls: unknown[] = []
  await mount(createGlobalSettingsClient(requestFrom(async (path, method = 'GET', body) => {if (method === 'GET') return initial(); calls.push({path, body}); return {...initial(), revision: 4}})))
  await change('配置名称', 'Pending draft'); await click('轮换加密密钥')
  expect(calls).toHaveLength(0)
  await click('确认重新加密')
  expect(calls).toEqual([{path: '/api/v1/admin/config/rotate-key', body: {expectedRevision: 3}}])
  expect(input('配置名称').value).toBe('Pending draft')
})

test('strict lifecycle cleanup waits for the authoritative read and scrubs a detached password input', async () => {
  const firstRead = deferred<AdminGlobalConfig>(); let reads = 0
  const client = createGlobalSettingsClient(requestFrom(async () => ++reads === 1 ? firstRead.promise : initial()))
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host); roots.push(root)
  await act(async () => root.render(h(StrictMode, null, h(GlobalSettingsPanel, {client, onClose() {}}))))
  await act(async () => firstRead.resolve({...initial(), entries: [{...initial().entries[0], label: 'Obsolete strict effect'}]}))
  expect(input('配置名称').value).toBe('Original')
  await change('API 密钥', 'discard-on-detach')
  const detachedInput = input('API 密钥')
  await act(async () => root.unmount()); roots.splice(roots.indexOf(root), 1)
  expect(detachedInput.value).toBe('')
  expect(detachedInput.outerHTML).not.toContain('discard-on-detach')
})


test('page presentation delegates its heading and close button while preserving draft status and close guards', async () => {
  let guard: (() => boolean) | null = null
  const pending = deferred<AdminGlobalConfig>()
  const client = createGlobalSettingsClient(requestFrom(async (_path, method = 'GET') => method === 'PUT' ? pending.promise : initial()))
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host); roots.push(root)
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
  try {
    await act(async () => root.render(h(GlobalSettingsPanel, {client, presentation: 'page', onClose() {}, onCloseGuardChange(next: (() => boolean) | null) {guard = next}})))
    expect(host.querySelector('h3')).toBeNull()
    expect(host.querySelector('[aria-label="关闭全局配置"]')).toBeNull()
    expect(host.querySelector('[aria-label="配置状态摘要"]')?.textContent).toContain('已保存配置')
    expect(host.querySelector('[aria-label="配置状态摘要"]')?.textContent).toContain('服务配置 1')
    expect(host.querySelector('[aria-label="配置状态摘要"]')?.textContent).toContain('已启用 1')
    expect(host.querySelector('.global-settings-page')).not.toBeNull()
    expect(guard?.()).toBe(true)
    expect(confirm).not.toHaveBeenCalled()
    await change('配置名称', 'Unsaved page')
    expect(host.querySelector('[aria-label="配置状态摘要"]')?.textContent).toContain('有未保存更改')
    expect(guard?.()).toBe(false)
    expect(confirm).toHaveBeenCalledOnce()
    await submit()
    expect(guard?.()).toBe(false)
    expect(confirm).toHaveBeenCalledOnce()
    await act(async () => pending.reject(new TypeError('network lost')))
    expect(guard?.()).toBe(false)
    expect(confirm).toHaveBeenCalledTimes(2)
    confirm.mockReturnValue(true)
    expect(guard?.()).toBe(true)
  } finally {confirm.mockRestore()}
})

test.each([408,503])('HTTP %i shows unknown protection, keeps drafts, and requires successful explicit reconciliation before resubmission',async status=>{
 let writes=0,readFails=false,timeout=true
 await mount(createGlobalSettingsClient(requestFrom(async(_path,method='GET')=>{
  if(method!=='GET'){writes++;if(timeout)throw Object.assign(new Error('timeout'),{status});return {...initial(),revision:4}}
  if(readFails)throw Object.assign(new Error('read failed'),{status:500})
  return initial()
 })))
 await change('配置名称','Timeout draft');await change('API 密钥','submitted-once');await submit()
 expect(button('保存配置').disabled).toBe(true);expect(document.body.textContent).toContain('写入结果待核对')
 expect(input('配置名称').value).toBe('Timeout draft');expect(input('API 密钥').value).toBe('')
 await submit();expect(writes).toBe(1)
 readFails=true;await click('读取最新配置');expect(button('保存配置').disabled).toBe(true)
 await submit();expect(writes).toBe(1)
 readFails=false;await click('读取最新配置');expect(button('保存配置').disabled).toBe(false);expect(writes).toBe(1)
 timeout=false;await submit();expect(writes).toBe(2)
})

test('saved server configuration uses independent bounded pages and clamps after a shorter refresh without discarding drafts', async () => {
  let config = initial()
  config.entries = Array.from({length: 23}, (_, index) => ({...initial().entries[0], id: `server-${index}`, label: `Server ${index}`}))
  config.defaults = {}
  await mount(createGlobalSettingsClient(requestFrom(async () => structuredClone(config))))
  const snapshot = () => document.querySelector<HTMLElement>('.global-settings-latest')!
  const labels = () => [...snapshot().querySelectorAll('li strong')].map(node => node.textContent)
  expect(labels()).toEqual(Array.from({length: 10}, (_, index) => `Server ${index}`))
  await change('配置名称', 'Unsaved local draft')
  const next = () => snapshot().querySelector<HTMLButtonElement>('[aria-label="下一页服务器当前配置"]')!
  await act(async () => next().click())
  expect(labels()).toEqual(Array.from({length: 10}, (_, index) => `Server ${index + 10}`))
  expect(input('配置名称').value).toBe('Unsaved local draft')
  await act(async () => next().click())
  expect(labels()).toEqual(['Server 20', 'Server 21', 'Server 22'])
  expect(next().disabled).toBe(true)
  config = {...config, revision: 4, entries: config.entries.slice(0, 2)}
  await click('读取最新配置')
  expect(labels()).toEqual(['Server 0', 'Server 1'])
  expect(snapshot().textContent).toContain('1–2 / 2')
  expect(input('配置名称').value).toBe('Unsaved local draft')
  expect(next().disabled).toBe(true)
})

test('refined settings keep the configuration selector, defaults and credential controls accessible', async () => {
 const {host} = await mount(createGlobalSettingsClient(requestFrom(async () => initial())))
 expect(host.querySelector('.global-settings-refined')).not.toBeNull()
 expect(host.querySelector('.global-settings-config-select')?.textContent).toContain('Original')
 expect(input('API 密钥').type).toBe('password')
 expect(button('保存配置').disabled).toBe(true)
 expect(host.querySelector('[aria-label="默认配置"]')).not.toBeNull()
})

test('shared model connection test uses the saved entry and waits for unsaved edits to be saved',async()=>{
 const calls:Array<{path:string;body:unknown}>=[]
 await mount(createGlobalSettingsClient(requestFrom(async(path,method='GET',body)=>{
  if(method==='GET')return initial()
  calls.push({path,body});return {ok:true}
 })))
 expect(button('测试连接').disabled).toBe(false)
 await click('测试连接')
 expect(calls).toEqual([{path:'/api/v1/admin/config/test-model',body:{entryId:'primary'}}])
 expect(document.body.textContent).toContain('模型连接成功')
 expect(document.body.textContent).not.toMatch(/版本\s*\d/)
 await change('模型标识','unsaved-model')
 expect(button('测试连接').disabled).toBe(true)
 expect(document.body.textContent).toContain('请先保存，再测试连接')
})

test.each([
 ['PROVIDER_AUTH_REJECTED','请检查 API 密钥和模型访问权限'],
 ['PROVIDER_RATE_LIMITED','请检查供应商额度，或稍后重试'],
 ['PROVIDER_TEMPORARILY_UNAVAILABLE','供应商服务暂时不可用'],
 ['unexpected-private-provider-text','请检查 API 密钥、模型名称和接口地址'],
])('shared model connection test explains failure safely (%s)',async(reason,guidance)=>{
 await mount(createGlobalSettingsClient(requestFrom(async(_path,method='GET')=>method==='GET'?initial():{ok:false,reason})))
 await click('测试连接')
 expect(document.querySelector('[role="alert"]')?.textContent).toContain(guidance)
 expect(document.body.textContent).not.toContain(reason)
})

test('AI and media groups preserve drafts and credentials across navigation and save together', async () => {
  let submitted: SaveGlobalConfigRequest | undefined
  const config = initial()
  config.entries.push({id: 'picture', kind: 'image_generation', providerId: 'image', label: 'Team images', model: 'image-model', baseUrl: 'https://images.test/v1', enabled: true, hasKey: false})
  await mount(createGlobalSettingsClient(requestFrom(async (_path, method = 'GET', body) => {
    if (method === 'GET') return config
    submitted = body as SaveGlobalConfigRequest
    return {...config, revision: 4}
  })))
  await change('配置名称', 'Shared chat draft')
  await change('API 密钥', 'chat-draft-key')
  const switchGroup = async (name: string) => {await act(async () => {
    const tab = [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find(node => node.textContent === name)
    expect(tab).toBeDefined(); tab!.click()
  })}
  await switchGroup('生图、媒体与搜索')
  expect(input('配置名称').value).toBe('Team images')
  expect(input('API 密钥').value).toBe('')
  expect(document.querySelector('[aria-label="默认对话配置"]')).toBeNull()
  await change('API 密钥', 'image-draft-key')
  await switchGroup('AI 模型')
  expect(input('配置名称').value).toBe('Shared chat draft')
  expect(input('API 密钥').value).toBe('chat-draft-key')
  expect(document.querySelector('[aria-label="默认图像生成配置"]')).toBeNull()
  await submit()
  expect(submitted?.patch.upserts).toEqual(expect.arrayContaining([
    expect.objectContaining({id: 'primary', label: 'Shared chat draft', apiKey: 'chat-draft-key'}),
    expect.objectContaining({id: 'picture', apiKey: 'image-draft-key'}),
  ]))
  expect(document.body.textContent).not.toContain('Jev')
})

test('an empty media group offers each purpose and creates the selected service without changing chat', async () => {
  let submitted: SaveGlobalConfigRequest | undefined
  await mount(createGlobalSettingsClient(requestFrom(async (_path, method = 'GET', body) => {
    if (method === 'GET') return initial()
    submitted = body as SaveGlobalConfigRequest
    return {...initial(), revision: 4}
  })))
  await act(async () => [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find(node => node.textContent === '生图、媒体与搜索')!.click())
  for (const purpose of ['图像生成', '图像分析', '视频分析', '网页搜索', '图片搜索']) expect(button(`配置${purpose}`)).toBeDefined()
  await click('配置图像生成')
  expect(input('模型标识').value).toBe('image-model')
  expect(input('服务地址').value).toBe('https://images.test/v1')
  await submit()
  expect(submitted?.patch.upserts).toHaveLength(1)
  expect(submitted?.patch.upserts?.[0]).toMatchObject({kind: 'image_generation', providerId: 'image'})
  expect(submitted?.patch.removes).toBeUndefined()
})

test('failed initial configuration load offers an immediate retry', async () => {
  let reads = 0
  await mount(createGlobalSettingsClient(requestFrom(async () => {if (++reads === 1) throw Object.assign(new Error('offline'), {status: 503}); return initial()})))
  expect(document.querySelector('form')).toBeNull()
  await click('重新读取')
  expect(reads).toBe(2)
  expect(input('配置名称').value).toBe('Original')
  expect(document.querySelector('[aria-label="当前配置状态"]')?.textContent).toContain('密钥已保存')
})

test('toolbar discard requires confirmation and reloads without submitting a draft', async () => {
  let reads = 0; let writes = 0
  await mount(createGlobalSettingsClient(requestFrom(async (_path, method = 'GET') => {if (method !== 'GET') writes++; else reads++; return initial()})))
  await change('配置名称', 'Unwanted draft')
  await change('API 密钥', 'draft-only-key')
  expect(document.querySelector('[aria-label="当前配置状态"]')?.textContent).toContain('新密钥待保存')
  await click('放弃更改')
  expect(reads).toBe(1)
  expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain('放弃未保存草稿')
  await click('取消')
  expect(input('配置名称').value).toBe('Unwanted draft')
  await click('放弃更改'); await click('确认放弃草稿')
  expect(reads).toBe(2)
  expect(writes).toBe(0)
  expect(input('配置名称').value).toBe('Original')
  expect(input('API 密钥').value).toBe('')
})


test('global configuration uses native controls and searches configuration choices without losing unsaved secrets',async()=>{
 const config=initial();config.entries.push({...config.entries[0],id:'second',label:'Second model'})
 const {host}=await mount(createGlobalSettingsClient(requestFrom(async()=>config)))
 expect(host.querySelectorAll('[class*="ant-"]')).toHaveLength(0)
 await change('API 密钥','private-draft')
 await change('搜索服务配置','Second')
 await choose('选择服务配置','Second model')
 expect(input('API 密钥').value).toBe('')
 await change('搜索服务配置','Original')
 await choose('选择服务配置','Original')
 expect(input('API 密钥').value).toBe('private-draft')
})


test('native save button submits the associated form exactly once',async()=>{
 const writes:unknown[]=[]
 await mount(createGlobalSettingsClient(requestFrom(async(_path,method='GET',body)=>{if(method==='GET')return initial();writes.push(body);return {...initial(),revision:4}})))
 await change('配置名称','Saved by button')
 await click('保存配置')
 expect(writes).toHaveLength(1)
 expect(writes[0]).toMatchObject({expectedRevision:3,patch:{upserts:[{id:'primary',label:'Saved by button'}]}})
})
