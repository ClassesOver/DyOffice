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

