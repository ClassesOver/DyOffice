import test from 'node:test'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {ASSISTANT_PREFERENCES_FIELDS} from '../../../packages/web-contracts/src/preferences.ts'
const root=new URL('../../../',import.meta.url).pathname.replace(/\/$/,'')
const require=createRequire(root+'/package.json')
const Fastify=require('fastify')
const {createLocalShellClient}=await import(root+'/apps/web/src/shell/local-client.ts')
const {createLocalPreferencesSession}=await import(root+'/apps/web/src/shell/local-preferences-session.ts')
const {registerPreferenceRoutes}=await import(root+'/apps/web/server/src/modules/preferences/routes.ts')
const {registerAuthRoutes}=await import(root+'/apps/web/server/src/modules/auth/routes.ts')
const {createCsrfService,SESSION_COOKIE}=await import(root+'/apps/web/server/src/modules/auth/csrf.ts')
async function fixture(){
 const app=Fastify(); const tokens={A:'a'.repeat(43),B:'b'.repeat(43)};let account='A';const calls=[]
 const prefs={A:{theme:'light',language:'zh',authorName:'Alice',autoSave:true,showAssistant:true},B:{theme:'dark',language:'en',authorName:'Bob',autoSave:false,showAssistant:false}}
 const owner=token=>{const key=Object.keys(tokens).find(k=>tokens[k]===token);if(!key)throw Object.assign(new Error('Unauthorized'),{statusCode:401});return key}
 const sessions={async authenticate(token){const id=owner(token);return{userId:id,username:id,roles:[]}}}
 const csrf=createCsrfService({db:{pool:{query:async()=>{throw new Error('unexpected login challenge')}}},deploymentId:'test',origin:'https://office.test',key:'test-secret'.repeat(5)})
 registerAuthRoutes(app,{sessions,csrf,throttle:{},users:{}})
 registerPreferenceRoutes(app,{async get(token){return prefs[owner(token)]},async update(token,patch){const id=owner(token);prefs[id]={...prefs[id],...patch};return prefs[id]}},sessions,csrf)
 const client=createLocalShellClient(async(path,init)=>{calls.push([account,path,init.method]);const response=await app.inject({url:path,method:init.method,headers:{...init.headers,cookie:`${SESSION_COOKIE}=${tokens[account]}`,origin:'https://office.test'},...(init.body===undefined?{}:{payload:init.body})});return new Response(response.body,{status:response.statusCode,headers:{'content-type':'application/json'}})})
 return{app,client,prefs,calls,switchToB(){account='B'}}
}
test('stale workspace preferences cannot mutate a different cookie account on first save',async()=>{
 const f=await fixture();try{
  const scoped=createLocalPreferencesSession(f.client);scoped.bind(await f.client.bindSession());
  await scoped.preferences.getPreferences();f.switchToB();
  await assert.rejects(scoped.preferences.updatePreferences({authorName:'Alice draft'}));
  assert.equal(f.prefs.B.authorName,'Bob');
 }finally{await f.app.close()}
})
test('cached-CSRF account switch remains blocked on repeated saves and opens recovery',async()=>{
 const f=await fixture();try{
  let ended=0;f.client.onSessionEnded(()=>ended++)
  const scoped=createLocalPreferencesSession(f.client);scoped.bind(await f.client.bindSession());
  await scoped.preferences.updatePreferences({theme:'dark'});f.switchToB();
  await assert.rejects(scoped.preferences.updatePreferences({authorName:'Alice draft'}));
  await assert.rejects(scoped.preferences.updatePreferences({authorName:'Alice draft'}));
  assert.equal(f.prefs.B.authorName,'Bob');assert.equal(ended,1)
  assert.equal(f.calls.filter(c=>c[0]==='B'&&c[1].endsWith('/csrf')).length,0)
 }finally{await f.app.close()}
})
test('switched-account preferences are not returned to an old workspace and recovery is emitted',async()=>{
 const f=await fixture();try{
  let ended=0;f.client.onSessionEnded(()=>ended++)
  const scoped=createLocalPreferencesSession(f.client);scoped.bind(await f.client.bindSession());f.switchToB();
  await assert.rejects(scoped.preferences.getPreferences(),{code:'stale_session'});assert.equal(ended,1)
 }finally{await f.app.close()}
})
const initial={theme:'light',language:'zh',authorName:'Alice',autoSave:true,showAssistant:true}
function lifecycle(){
 const client=createLocalShellClient(async()=>{throw new Error('Unexpected network')})
 const scoped=createLocalPreferencesSession(client)
 return{client,scoped,bind(request){scoped.bind({proof:'a'.repeat(43),request})}}
}
test('same-user rebind preserves an existing unknown write until a valid new read',async()=>{
 const f=lifecycle();let writes=0
 f.bind(async(_path,method)=>{if(method==='PUT'){writes++;throw Object.assign(new Error('timeout'),{status:408})}return initial})
 await assert.rejects(f.scoped.preferences.updatePreferences({theme:'dark'}),/timeout/)
 f.bind(async(_path,method)=>{if(method==='PUT')writes++;return initial})
 await assert.rejects(f.scoped.preferences.updatePreferences({theme:'dark'}),/尚未确认/);assert.equal(writes,1)
 await f.scoped.preferences.getPreferences();await f.scoped.preferences.updatePreferences({theme:'dark'});assert.equal(writes,2)
})
test('late old write after verified rotation cannot report success or clear the pending fence',async()=>{
 const f=lifecycle();let release,writes=0
 f.bind(async(_path,method)=>{if(method==='PUT'){writes++;return new Promise(r=>{release=r})}return initial})
 const save=f.scoped.preferences.updatePreferences({theme:'dark'});await new Promise(r=>setImmediate(r))
 f.bind(async(_path,method)=>{if(method==='PUT')writes++;return initial})
 await assert.rejects(f.scoped.preferences.updatePreferences({theme:'dark'}),/正在保存/)
 release({...initial,theme:'dark'});await assert.rejects(save,/尚未确认/)
 await assert.rejects(f.scoped.preferences.updatePreferences({theme:'dark'}),/尚未确认/);assert.equal(writes,1)
 await f.scoped.preferences.getPreferences();await f.scoped.preferences.updatePreferences({theme:'dark'});assert.equal(writes,2)
})
test('old read cannot unlock an unknown write across rotation',async()=>{
 const f=lifecycle();let release,writes=0
 f.bind(async(_path,method)=>{if(method==='PUT'){writes++;throw new Error('lost')}return new Promise(r=>{release=r})})
 const oldRead=f.scoped.preferences.getPreferences()
 await assert.rejects(f.scoped.preferences.updatePreferences({theme:'dark'}),/lost/)
 f.bind(async()=>initial);release(initial);await assert.rejects(oldRead,{code:'stale_session'})
 await assert.rejects(f.scoped.preferences.updatePreferences({theme:'dark'}),/尚未确认/);assert.equal(writes,1)
})
test('session recovery rejects late writes and further requests without unmounting consumers',async()=>{
 const f=lifecycle();let release,calls=0
 f.bind(async()=>{calls++;return new Promise(r=>{release=r})})
 const save=f.scoped.preferences.updatePreferences({theme:'dark'});await new Promise(r=>setImmediate(r))
 f.client.endSession('expired');release(initial);await assert.rejects(save,/尚未确认/)
 await assert.rejects(f.scoped.preferences.getPreferences(),{code:'stale_session'});assert.equal(calls,1)
})
test('production restore and password-rotation wiring share the fenced preferences client',async()=>{
 const {readFile}=await import('node:fs/promises');const {runInNewContext}=await import('node:vm');const {transform}=await import('esbuild')
 const source=await readFile(new URL('../src/shell/local-main.tsx',import.meta.url),'utf8')
 const f=lifecycle();const writes=[];let owner='A',proof='a'.repeat(43)
 const workspace=()=>({bound:{proof,request:async(path,method,body)=>{if(path.endsWith('/me'))return{user:{id:owner}};if(path.endsWith('/capabilities'))return{};if(method==='PUT'){writes.push(proof);return {...initial,...body}}return initial}}})
 const context={createSourceWorkspaceSession:async()=>workspace(),preferenceSession:f.scoped,preferences:f.scoped.preferences,globalSettingsSession:{bind(){}},workspaceSession:{bind(){}},client:{...f.client,changePassword:async()=>{proof='b'.repeat(43);return proof}},user:null,userSkills:null,sourceWorkspace:null,entryRecovery:undefined,documentTabs:{list:()=>[],renderedDocuments:()=>[]},ASSISTANT_PREFERENCES_FIELDS,capabilities:{},initialLanguage:'zh',document:{documentElement:{dataset:{}}},installBridge(){},createUserSkillsClient:()=>({}),useState:()=>[0,()=>{}],useMemo:run=>run(),jsx:(type,props)=>({type,props}),WorkspaceSettings:'settings',sessionsClient:{},historyClient:{},UserSkillsPanel:'skills',logout(){}}
 const selected=source.slice(source.indexOf('function saveWorkspaceEntries('),source.indexOf('async function resolveOpenDocument('))+source.slice(source.indexOf('async function restore('),source.indexOf('async function logout('))+source.slice(source.indexOf('function WorkspacePageContent('),source.indexOf('function Account('))
 const {code}=await transform(selected,{loader:'tsx',jsxFactory:'jsx',target:'es2022'})
 const api=runInNewContext(code+'\n({restore,WorkspacePageContent,saveWorkspaceAssistantSide})',context)
 await api.restore();const props=api.WorkspacePageContent({page:'settings',onClose(){},onCloseGuardChange(){}}).props
 assert.equal(props.load,f.scoped.preferences.getPreferences)
 await props.save({theme:'dark'});assert.equal(writes.at(-1),'a'.repeat(43))
 await props.security.changePassword('old','new');await props.save({theme:'light'});assert.equal(writes.at(-1),'b'.repeat(43))
 await assert.rejects(api.saveWorkspaceAssistantSide('right','a'.repeat(43)),/登录状态已改变/)
 assert.equal(writes.length,2)
 assert.equal((await api.saveWorkspaceAssistantSide('right','b'.repeat(43))).aiPanelSide,'right')
 assert.equal(writes.at(-1),'b'.repeat(43))
 owner='B';await props.security.changePassword('old','new');await assert.rejects(props.save({theme:'dark'}));assert.equal(writes.length,3)
})
test('ordinary permission 403 with unchanged proof does not incorrectly end the workspace',async()=>{
 let ended=0,writes=0
 const proof='a'.repeat(43)
 const client=createLocalShellClient(async(path,init)=>{
  if(path.endsWith('/session-proof'))return new Response(JSON.stringify({csrfToken:proof}))
  if(init.method==='PUT'){writes++;return new Response(JSON.stringify({title:'Forbidden'}),{status:403})}
  return new Response(JSON.stringify(initial))
 })
 client.onSessionEnded(()=>ended++)
 const scoped=createLocalPreferencesSession(client);scoped.bind(await client.bindSession())
 await assert.rejects(scoped.preferences.updatePreferences({theme:'dark'}),{status:403})
 await assert.rejects(scoped.preferences.updatePreferences({theme:'dark'}),{status:403})
 assert.equal(writes,2);assert.equal(ended,0)
})
