import {afterEach,expect,test,vi} from 'vitest'
import {act,createElement as h} from 'react'
import {createRoot,type Root} from 'react-dom/client'
import {createLocalAdminClient,type LocalAdminClient} from '../../src/shell/local-admin-client'
import {LocalAdminPanel} from '../../src/shell/LocalAdminPanel'
;(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true
const user={id:'aa000000-0000-4000-8000-000000000001',username:'draft-user',displayName:'Draft User',status:'pending',roles:['personal'],requiresPasswordReset:false}
const created={user,action:{token:'a'.repeat(43),purpose:'activate',expiresAt:'2026-12-01T00:00:00Z'}}
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status})
let root:Root|undefined
async function mount(client:LocalAdminClient){document.body.innerHTML='<div id="admin-recovery"></div>';root=createRoot(document.getElementById('admin-recovery')!);await act(async()=>root!.render(h(LocalAdminPanel,{client,currentUserId:'me',onClose(){},onSessionRotated(){}})))}
afterEach(async()=>{if(root)await act(async()=>root!.unmount());root=undefined;document.body.innerHTML='';vi.restoreAllMocks()})
const button=(text:string)=>[...document.querySelectorAll<HTMLButtonElement>('button')].find(node=>node.textContent===text)!
async function click(text:string){await act(async()=>button(text).click())}
async function fill(label:string,value:string){await act(async()=>{const input=document.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}))})}
async function submitCreate(){await click('新建用户');await fill('新用户名','draft-user');await fill('显示名称','Draft User');await act(async()=>document.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));await fill('管理员当前密码','not-stored-password');await act(async()=>document.querySelector('form[aria-label="确认用户操作"]')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})))}
for(const stage of ['reauth','create'])test(`definite ${stage} rejection restores nonsecret create fields while clearing password`,async()=>{
 let writes=0
 const client=createLocalAdminClient((async(path:string,init?:RequestInit)=>path.endsWith('/csrf')?json({csrfToken:'csrf'}):path.endsWith('/reauth')?json({csrfToken:'proof'},stage==='reauth'?400:200):init?.method==='POST'?(writes++,json({},400)):json({users:[],nextCursor:null})) as typeof fetch)
 await mount(client);await submitCreate()
 expect(document.querySelector<HTMLInputElement>('[aria-label="新用户名"]')?.value).toBe('draft-user')
 expect(document.querySelector<HTMLInputElement>('[aria-label="显示名称"]')?.value).toBe('Draft User')
 expect(document.querySelector('[aria-label="管理员当前密码"]')).toBeNull();expect(document.body.textContent).not.toContain('not-stored-password');expect(writes).toBe(stage==='reauth'?0:1)
})
test('unknown business writes are rejected by the stable client until a valid list read succeeds',async()=>{
 let writes=0,readFails=false,writeFails=true
 const client=createLocalAdminClient((async(path:string,init?:RequestInit)=>{if(path.endsWith('/csrf'))return json({csrfToken:'csrf'});if(init?.method==='POST'){writes++;return json(created,writeFails?500:200)}return json({users:[],nextCursor:null},readFails?500:200)}) as typeof fetch)
 await client.create('draft-user','Draft User').catch(()=>{});await client.create('draft-user','Draft User').catch(()=>{});expect(writes).toBe(1)
 readFails=true;await client.list().catch(()=>{});await client.create('draft-user','Draft User').catch(()=>{});expect(writes).toBe(1)
 readFails=false;await client.list();writeFails=false;await client.create('draft-user','Draft User');expect(writes).toBe(2)
})
test('reopening after an unknown write and failed list read keeps UI writes disabled until refresh succeeds',async()=>{
 let writes=0,readFails=false
 const client=createLocalAdminClient((async(path:string,init?:RequestInit)=>path.endsWith('/csrf')?json({csrfToken:'csrf'}):path.endsWith('/reauth')?json({csrfToken:'proof'}):init?.method==='POST'?(writes++,json({},500)):json({users:[],nextCursor:null},readFails?500:200)) as typeof fetch)
 await mount(client);await submitCreate();expect(button('新建用户').disabled).toBe(true)
 vi.spyOn(window,'confirm').mockReturnValue(true);await click('关闭用户管理')
 await act(async()=>root!.unmount());root=undefined;readFails=true;await mount(client)
 expect(button('新建用户').disabled).toBe(true);expect(document.body.textContent).toContain('上次操作结果未确认')
 readFails=false;await click('刷新列表');expect(button('新建用户').disabled).toBe(false);expect(writes).toBe(1)
})
for(const stage of ['csrf','reauth'])test(`${stage} read failure does not fence a business write that never started`,async()=>{
 let fails=true,writes=0
 const client=createLocalAdminClient((async(path:string,init?:RequestInit)=>{if(path.endsWith('/csrf'))return json({csrfToken:'csrf'},fails&&stage==='csrf'?500:200);if(path.endsWith('/reauth'))return json({csrfToken:'proof'},fails&&stage==='reauth'?500:200);if(init?.method==='POST'){writes++;return json(created)}return json({users:[],nextCursor:null})}) as typeof fetch)
 if(stage==='reauth')await client.reauthenticate('password').catch(()=>{});else await client.create('draft-user','Draft User').catch(()=>{})
 expect(writes).toBe(0);fails=false;await client.create('draft-user','Draft User');expect(writes).toBe(1)
})
for(const operation of ['issue','status','roles'] as const)test(`unknown ${operation} blocks every business write until list reconciliation`,async()=>{
 let writes=0
 const client=createLocalAdminClient((async(path:string,init?:RequestInit)=>{if(path.endsWith('/csrf'))return json({csrfToken:'csrf'});if(init?.method!=='GET'){writes++;return json({},500)}return json({users:[],nextCursor:null})}) as typeof fetch)
 const write=()=>operation==='issue'?client.issue(user.id,'reset'):operation==='status'?client.setStatus(user.id,'disabled'):client.setRoles(user.id,['personal'])
 await write().catch(()=>{});await client.create('another','Another').catch(()=>{});expect(writes).toBe(1)
 await client.list();await write().catch(()=>{});expect(writes).toBe(2)
})
test('malformed successful write stays fenced after malformed list reconciliation',async()=>{
 let writes=0
 const client=createLocalAdminClient((async(path:string,init?:RequestInit)=>{if(path.endsWith('/csrf'))return json({csrfToken:'csrf'});if(init?.method==='POST'){writes++;return json({})}return json({users:[{}],nextCursor:null})}) as typeof fetch)
 await client.create('draft-user','Draft User').catch(()=>{});await client.list().catch(()=>{});await client.create('draft-user','Draft User').catch(()=>{});expect(writes).toBe(1)
})
test('a business CSRF read failure restores the create draft without setting the panel unknown fence',async()=>{
 let csrf=0,writes=0
 const client=createLocalAdminClient((async(path:string,init?:RequestInit)=>{if(path.endsWith('/csrf'))return json({csrfToken:'csrf'},++csrf===2?500:200);if(path.endsWith('/reauth'))return json({csrfToken:'proof'});if(init?.method==='POST'){writes++;return json(created)}return json({users:[],nextCursor:null})}) as typeof fetch)
 await mount(client);await submitCreate()
 expect(document.querySelector<HTMLInputElement>('[aria-label="新用户名"]')?.value).toBe('draft-user')
 expect(document.body.textContent).not.toContain('上次操作结果未确认');expect(writes).toBe(0);expect(client.getState().unknownWrite).toBe(false)
})
test('a list started before a failed mutation cannot acknowledge that newer unknown write',async()=>{
 let finish!:(response:Response)=>void,writes=0
 const client=createLocalAdminClient((async(path:string,init?:RequestInit)=>path.endsWith('/csrf')?json({csrfToken:'csrf'}):init?.method==='POST'?(writes++,json({},500)):new Promise<Response>(resolve=>{finish=resolve})) as typeof fetch)
 const read=client.list();await client.create('draft-user','Draft User').catch(()=>{});finish(json({users:[],nextCursor:null}));await read
 await client.create('draft-user','Draft User').catch(()=>{});expect(writes).toBe(1)
})
test('a second old reconciliation response cannot clear a later mutation failure',async()=>{
 const reads:((response:Response)=>void)[]=[],clientWrites:string[]=[]
 const client=createLocalAdminClient((async(path:string,init?:RequestInit)=>path.endsWith('/csrf')?json({csrfToken:'csrf'}):init?.method==='POST'?(clientWrites.push(path),json({},500)):new Promise<Response>(resolve=>reads.push(resolve))) as typeof fetch)
 await client.create('first','First').catch(()=>{});const first=client.list(),second=client.list();reads[0](json({users:[],nextCursor:null}));await first
 await client.create('second','Second').catch(()=>{});reads[1](json({users:[],nextCursor:null}));await second
 await client.create('third','Third').catch(()=>{});expect(clientWrites).toHaveLength(2)
})
test('same-turn client calls share a synchronous business-operation lock before CSRF completes',async()=>{
 let finish!:(response:Response)=>void,csrf=0,writes=0
 const client=createLocalAdminClient((async(path:string)=>{if(path.endsWith('/csrf'))return ++csrf===1?new Promise<Response>(resolve=>{finish=resolve}):json({csrfToken:'csrf'});writes++;return json(created)}) as typeof fetch)
 const first=client.create('first','First'),second=client.create('second','Second').catch(()=>{});await second;finish(json({csrfToken:'csrf'}));await first
 expect(csrf).toBe(1);expect(writes).toBe(1)
})
test('successful own-role change clears admin unload state while preserving the editor unload guard',async()=>{
 const changed=vi.fn(),client=createLocalAdminClient((async(path:string,init?:RequestInit)=>path.endsWith('/csrf')?json({csrfToken:'csrf'}):path.endsWith('/reauth')?json({csrfToken:'proof'}):init?.method==='PATCH'?json({user}):json({users:[user],nextCursor:null})) as typeof fetch)
 document.body.innerHTML='<div id="admin-recovery"></div>';root=createRoot(document.getElementById('admin-recovery')!)
 await act(async()=>root!.render(h(LocalAdminPanel,{client,currentUserId:user.id,onClose(){},onSessionRotated(){},onOwnAuthorityChanged:changed})))
 await click('编辑角色')
 const before=new Event('beforeunload',{cancelable:true});window.dispatchEvent(before);expect(before.defaultPrevented).toBe(true)
 await fill('管理员当前密码','not-stored-password')
 await act(async()=>document.querySelector('form[aria-label="确认用户操作"]')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})))
 expect(changed).toHaveBeenCalledOnce()
 const after=new Event('beforeunload',{cancelable:true});window.dispatchEvent(after);expect(after.defaultPrevented).toBe(false)
 expect(document.querySelector('form[aria-label="确认用户操作"]')).toBeNull()
 const editorGuard=(event:Event)=>event.preventDefault();window.addEventListener('beforeunload',editorGuard)
 try{const external=new Event('beforeunload',{cancelable:true});window.dispatchEvent(external);expect(external.defaultPrevented).toBe(true)}finally{window.removeEventListener('beforeunload',editorGuard)}
})
