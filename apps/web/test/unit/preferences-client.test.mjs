import test from 'node:test'
import assert from 'node:assert/strict'
import {createPreferencesClient} from '../../../../packages/browser-host/src/preferences.ts'

const initial={theme:'light',language:'zh',authorName:'Alice',autoSave:false,showAssistant:true}
test('preference save is single-flight across replacement consumers and load waits for its outcome',async()=>{
 let release;let writes=0
 const client=createPreferencesClient(async(_path,method)=>method==='PUT'?(writes++,new Promise(resolve=>{release=resolve})):initial)
 const saved=client.updatePreferences({theme:'dark'})
 await assert.rejects(client.updatePreferences({theme:'light'}),/正在保存/)
 const loaded=client.getPreferences();release({...initial,theme:'dark'})
 assert.equal((await saved).theme,'dark');assert.equal((await loaded).theme,'dark');assert.equal(writes,1)
})
test('malformed success and uncertain transport results require authoritative reload before another save',async()=>{
 let writes=0;let malformed=true
 const client=createPreferencesClient(async(_path,method)=>method==='PUT'?(writes++,malformed?{}:{...initial,theme:'dark'}):initial)
 await assert.rejects(client.updatePreferences({theme:'dark'}),/无法确认/)
 await assert.rejects(client.updatePreferences({theme:'dark'}),/重新加载/);assert.equal(writes,1)
 await client.getPreferences();malformed=false;assert.equal((await client.updatePreferences({theme:'dark'})).theme,'dark');assert.equal(writes,2)
})
test('personal client rejects global fields and only projects personal response fields',async()=>{
 let calls=0
 const client=createPreferencesClient(async()=>{calls++;return {...initial,apiKey:'not-a-preference',models:['injected']}})
 await assert.rejects(client.updatePreferences({apiKey:'injected'}),/个人偏好/);assert.equal(calls,0)
 assert.deepEqual(await client.getPreferences(),initial)
})
test('known rejected writes remain retryable and public catalog uses its separate endpoint',async()=>{
 let fail=true;const paths=[]
 const client=createPreferencesClient(async(path,method)=>{paths.push(path);if(method==='PUT'&&fail)throw Object.assign(new Error('Forbidden'),{status:403});return path.endsWith('/public')?{revision:0,catalog:[],defaults:{}}:initial})
 await assert.rejects(client.updatePreferences({authorName:'Draft'}),/Forbidden/);fail=false
 await client.updatePreferences({authorName:'Draft'});assert.deepEqual(await client.getPublicSettings(),{revision:0,catalog:[],defaults:{}})
 assert.equal(paths.at(-1),'/api/v1/settings/public')
})

for(const status of [408,503])test(`preference HTTP ${status} requires a valid read before resubmission`,async()=>{
 let writes=0,read='failure'
 const client=createPreferencesClient(async(_path,method)=>{
  if(method==='PUT'){writes++;throw Object.assign(Error('response uncertain'),{status})}
  if(read==='failure')throw Error('read failed')
  return read==='malformed'?{}:initial
 })
 await assert.rejects(client.updatePreferences({authorName:'Draft'}),/uncertain/)
 await assert.rejects(client.updatePreferences({authorName:'Draft'}),/尚未确认/);assert.equal(writes,1)
 await assert.rejects(client.getPreferences(),/read failed/)
 await assert.rejects(client.updatePreferences({authorName:'Draft'}),/尚未确认/)
 read='malformed';await assert.rejects(client.getPreferences(),/无法确认/)
 await assert.rejects(client.updatePreferences({authorName:'Draft'}),/尚未确认/)
 read='valid';await client.getPreferences()
 await assert.rejects(client.updatePreferences({authorName:'Draft'}),/uncertain/);assert.equal(writes,2)
})
test('a preference read started before a later uncertain save cannot unlock another write',async()=>{
 let finish,writes=0
 const client=createPreferencesClient(async(_path,method)=>{
  if(method==='PUT'){writes++;throw Error('response lost')}
  return new Promise(resolve=>{finish=resolve})
 })
 const oldRead=client.getPreferences()
 await assert.rejects(client.updatePreferences({theme:'dark'}),/response lost/)
 finish(initial);await oldRead
 await assert.rejects(client.updatePreferences({theme:'dark'}),/尚未确认/)
 assert.equal(writes,1)
})

test('workspace session and sleep opt-outs round trip and reject malformed preference receipts',async()=>{
 let value=initial
 const client=createPreferencesClient(async(_path,method,patch)=>{
  if(method==='PUT')value={...value,...patch}
  return value
 })
 assert.equal((await client.updatePreferences({restoreSession:false})).restoreSession,false)
 assert.equal((await client.updatePreferences({sleepInactiveTabs:false})).sleepInactiveTabs,false)
 const saved=await client.getPreferences()
 assert.equal(saved.restoreSession,false)
 assert.equal(saved.sleepInactiveTabs,false)
 value={...value,sleepInactiveTabs:'false'}
 await assert.rejects(client.getPreferences(),/无法确认/)
})

test('PDF zoom preferences round trip and reject unknown modes',async()=>{
 let value=initial
 const client=createPreferencesClient(async(_path,method,patch)=>{
  if(method==='PUT')value={...value,...patch}
  return value
 })
 for(const pdfDefaultZoom of ['page','last','width']){
  assert.equal((await client.updatePreferences({pdfDefaultZoom})).pdfDefaultZoom,pdfDefaultZoom)
  assert.equal((await client.getPreferences()).pdfDefaultZoom,pdfDefaultZoom)
 }
 value={...value,pdfDefaultZoom:'actual'}
 await assert.rejects(client.getPreferences(),/无法确认/)
})

test('document appearance is independent of the workspace theme',async()=>{
 let value=initial
 const client=createPreferencesClient(async(_path,method,patch)=>{
  if(method==='PUT')value={...value,...patch}
  return value
 })
 const saved=await client.updatePreferences({theme:'dark',documentTheme:'light'})
 assert.equal(saved.theme,'dark')
 assert.equal(saved.documentTheme,'light')
 assert.equal((await client.updatePreferences({documentTheme:'follow'})).documentTheme,'follow')
 value={...value,documentTheme:'system'}
 await assert.rejects(client.getPreferences(),/无法确认/)
})

test('assistant appearance round trips and rejects malformed receipts',async()=>{
 let value=initial
 const client=createPreferencesClient(async(_path,method,patch)=>{
  if(method==='PUT')value={...value,...patch}
  return value
 })
 const appearance={aiFontSize:'custom',aiCustomFontSize:21,aiSpellcheck:false}
 assert.deepEqual(await client.updatePreferences(appearance),{...initial,...appearance})
 assert.deepEqual(await client.getPreferences(),{...initial,...appearance})
 for(const invalid of [{aiFontSize:'huge'},{aiCustomFontSize:33},{aiCustomFontSize:12.5},{aiSpellcheck:'false'}]){
  value={...initial,...appearance,...invalid}
  await assert.rejects(client.getPreferences(),/无法确认/)
 }
})

test('assistant startup preference persists both choices and rejects a non-boolean receipt',async()=>{
 let response=initial
 const client=createPreferencesClient(async(_path,method,patch)=>{
  if(method==='PUT')response={...response,...patch}
  return response
 })
 for(const aiOpenInNewDocs of [true,false]){
  assert.equal((await client.updatePreferences({aiOpenInNewDocs})).aiOpenInNewDocs,aiOpenInNewDocs)
  assert.equal((await client.getPreferences()).aiOpenInNewDocs,aiOpenInNewDocs)
 }
 response={...response,aiOpenInNewDocs:'false'}
 await assert.rejects(client.getPreferences(),/无法确认/)
})
