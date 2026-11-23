import {expect,it} from 'vitest'
import {createLocalShellClient} from '../../src/shell/local-client'
import {createLocalGlobalSettingsSession} from '../../src/shell/local-global-settings-session'
const snapshot=(revision=1)=>({revision,entries:[],defaults:{},providerCatalog:[],keyStorageAvailable:true})
it('an old global settings workspace cannot silently acquire the next account proof for a write',async()=>{
 let cookie='a'.repeat(43),writes=0
 const send:typeof fetch=async(path,init)=>{
  if(String(path).includes('/auth/'))return Response.json({csrfToken:cookie})
  if(init?.method==='PUT'){
   if(new Headers(init.headers).get('X-CSRF-Token')!==cookie)return new Response(null,{status:403})
   writes++;return Response.json(snapshot(2))
  }
  return Response.json(snapshot())
 }
 const shell=createLocalShellClient(send)
 const session=createLocalGlobalSettingsSession(shell)
 session.bind(await shell.bindSession()) // Current verified workspace A, like restore().
 const global=session.settings
 await global.load();cookie='b'.repeat(43)
 await expect(global.save(1,{defaults:{chat:null}})).rejects.toMatchObject({code:'stale_session'})
 expect(writes).toBe(0)
})

it('a verified same-user rotation preserves a late committed write as unknown until explicit reconciliation',async()=>{
 let cookie='a'.repeat(43),release!:(value:Response)=>void,reached!:()=>void,writes=0
 const entered=new Promise<void>(resolve=>reached=resolve)
 const shell=createLocalShellClient(async(path,init)=>{
  if(String(path).includes('/auth/'))return Response.json({csrfToken:cookie})
  if(init?.method==='PUT'){writes++;reached();return new Promise(resolve=>release=resolve)}
  return Response.json(snapshot(2))
 })
 const session=createLocalGlobalSettingsSession(shell),settings=session.settings
 session.bind(await shell.bindSession())
 const write=settings.save(1,{defaults:{chat:null}});await entered
 cookie='b'.repeat(43);session.bind(await shell.bindSession())
 release(Response.json(snapshot(2)))
 await expect(write).rejects.toMatchObject({code:'write_unknown'})
 expect(session.settings).toBe(settings);expect(settings.getState().unknownWrite).toBe(true)
 await expect(settings.save(2,{defaults:{chat:null}})).rejects.toMatchObject({code:'write_unknown'});expect(writes).toBe(1)
 await settings.load();expect(settings.getState().unknownWrite).toBe(true)
 await settings.load({reconcile:true});expect(settings.getState().unknownWrite).toBe(false)
})
it('a late old-session read is discarded and ordinary 403 does not invent rotation',async()=>{
 let cookie='a'.repeat(43),release!:(value:Response)=>void,recovery=0,deny=false
 const shell=createLocalShellClient(async(path,init)=>{
  if(String(path).includes('/auth/'))return Response.json({csrfToken:cookie})
  if(deny)return new Response(null,{status:403})
  return new Promise(resolve=>release=resolve)
 })
 shell.onSessionEnded(()=>recovery++)
 const session=createLocalGlobalSettingsSession(shell);session.bind(await shell.bindSession())
 const old=session.settings.load();await Promise.resolve();cookie='b'.repeat(43);session.bind(await shell.bindSession())
 release(Response.json(snapshot()))
 await expect(old).rejects.toMatchObject({code:'stale_session'});expect(recovery).toBe(0)
 deny=true;await expect(session.settings.save(1,{defaults:{chat:null}})).rejects.toMatchObject({code:'forbidden'})
 expect(recovery).toBe(0);expect(session.settings.getState().unknownWrite).toBe(false)
})
it('a session-ended global settings client cannot read or dispatch another mutation',async()=>{
 let calls=0
 const shell=createLocalShellClient(async()=>{calls++;return Response.json({csrfToken:'a'.repeat(43)})})
 const session=createLocalGlobalSettingsSession(shell);session.bind(await shell.bindSession());shell.endSession('expired');const before=calls
 await expect(session.settings.load()).rejects.toMatchObject({code:'stale_session'})
 await expect(session.settings.save(1,{defaults:{chat:null}})).rejects.toMatchObject({code:'stale_session'})
 expect(calls).toBe(before)
})
it('the production shell binds the stable configuration client during restore and verified rotation',async()=>{
 const {readFileSync}=await import('node:fs');const source=readFileSync('src/shell/local-main.tsx','utf8')
 expect(source).toContain('const globalSettingsSession=createLocalGlobalSettingsSession(client)')
 expect(source).toContain('const globalSettings=globalSettingsSession.settings')
 expect(source.match(/globalSettingsSession.bind\(bound\)/g)).toHaveLength(2)
 expect(source).not.toContain('createGlobalSettingsClient(client.request)')
})
