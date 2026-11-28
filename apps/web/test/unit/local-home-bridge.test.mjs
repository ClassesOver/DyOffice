import test from 'node:test'
import assert from 'node:assert/strict'
import {createLocalHomeBridge} from '../../src/shell/local-home-bridge.ts'

const item={id:'file-a',name:'one.docx',format:'docx',size:12,updatedAt:'2026-01-01T00:00:00Z',starred:false,folderId:null,lastOpenedAt:'2026-01-02T00:00:00Z'}
const prefs={getPreferences:async()=>({theme:'light',language:'zh'}),updatePreferences:async v=>v}
const deps=request=>({request,preferences:prefs,open:async()=>{},openTrash:()=>{},browse:async()=>{},changed:()=>{},unsupported:()=>{}})
test('local Home stars come from persistence across bridge instances and repeated clicks share one write',async()=>{
 let star=false,writes=0,release
 const request=async(path,method,body)=>{
  if(method==='PUT'){writes++;await new Promise(resolve=>{release=resolve});star=body.starred;return}
  return {files:[{...item,starred:star}],total:1,totalAll:1}
 }
 const bridge=createLocalHomeBridge(deps(request));const a=bridge.toggleStar('file-a');const b=bridge.toggleStar('file-a')
 await new Promise(resolve=>setImmediate(resolve));assert.equal(writes,1);release();await Promise.all([a,b])
 assert.equal((await createLocalHomeBridge(deps(request)).starred()).entries[0].starred,true)
})
test('recent removal uses its isolated operation and preserves file identity and all-file search',async()=>{
 const calls=[];let recent=true
 const bridge=createLocalHomeBridge(deps(async(path,method)=>{
  calls.push({path,method});if(method==='DELETE'){recent=false;return}
  const all=path.includes('view=recent')&&!recent?[]:[item];const files=path.includes('limit=0')?[]:all;return {files,total:all.length,totalAll:all.length}
 }))
 assert.equal((await bridge.recents({limit:0})).total,1)
 await bridge.removeRecent(['file-a']);assert.equal((await bridge.recents()).total,0)
 assert.equal((await bridge.searchFiles({q:'ONE'})).hits[0].path,'file-a')
 assert.deepEqual(calls.filter(c=>c.method==='DELETE').map(c=>c.path),['/api/v1/workspace/files/file-a/recent'])
})
test('original folder UI maps server identities to stable nested virtual paths',async()=>{
 const calls=[];const folders=[{id:'parent',name:'Projects',parentId:null,updatedAt:'2026-01-01'}, {id:'child',name:'Reports',parentId:'parent',updatedAt:'2026-01-01'}]
 const bridge=createLocalHomeBridge(deps(async(path,method,body)=>{
  calls.push({path,method,body});if(method==='PATCH')return {...folders[1],parentId:null}
  return path.endsWith('/folders')?{folders}:{files:[item],total:1,totalAll:1}
 }))
 assert.equal((await bridge.folderRoots())[0].path,'/workspace')
 const root=await bridge.listFolder('/workspace');assert.equal(root.folders[0].path,'/workspace/parent')
 const child=await bridge.listFolder('/workspace/parent');assert.equal(child.folders[0].path,'/workspace/parent/child')
 assert.deepEqual((await bridge.movePaths(['/workspace/parent/child'],'/workspace','ask')).moved,[{from:'/workspace/parent/child',to:'/workspace/child'}])
 assert.deepEqual(calls.find(c=>c.method==='PATCH').body,{parentId:null})
})
test('failed star write cannot manufacture success or change the next server projection',async()=>{
 let changed=0;const bridge=createLocalHomeBridge({...deps(async(_path,method)=>{if(method==='PUT')throw new Error('rejected');return {files:[item],total:1,totalAll:1}}),changed:()=>changed++})
 await assert.rejects(bridge.toggleStar('file-a'),/rejected/)
 assert.equal((await bridge.recents()).entries[0].starred,false)
 assert.equal(changed,0)
})

test('different folder names are not silently merged into one create operation',async()=>{
 const names=[];let finish
 const gate=new Promise(resolve=>{finish=resolve})
 const bridge=createLocalHomeBridge(deps(async(_path,_method,body)=>{
  names.push(body.name);await gate;return {id:body.name}
 }))
 const first=bridge.createFolder('/workspace','First'),second=bridge.createFolder('/workspace','Second')
 await new Promise(resolve=>setImmediate(resolve));finish()
 const result=await Promise.all([first,second])
 assert.deepEqual(names,['First','Second'])
 assert.deepEqual(result.map(item=>item.path),['/workspace/First','/workspace/Second'])
})

test('deduplicated identical moves report their authoritative result to every caller',async()=>{
 let count=0,finish;const gate=new Promise(resolve=>{finish=resolve})
 const bridge=createLocalHomeBridge(deps(async()=>{count++;await gate}))
 const first=bridge.movePaths(['file-a'],'/workspace/target','ask'),second=bridge.movePaths(['file-a'],'/workspace/target','ask')
 await new Promise(resolve=>setImmediate(resolve));finish()
 const [a,b]=await Promise.all([first,second])
 assert.equal(count,1);assert.deepEqual(a.moved,[{from:'file-a',to:'file-a'}]);assert.deepEqual(b,a)
})

test('an explicit unstar cannot be swallowed by an opposite toggle already in flight',async()=>{
 let finish,starred=false;const writes=[]
 const bridge=createLocalHomeBridge(deps(async(_path,method,body)=>{
  if(method==='PUT'){writes.push(body.starred);if(body.starred)await new Promise(resolve=>{finish=resolve});starred=body.starred;return}
  return {files:[{...item,starred}],total:1,totalAll:1}
 }))
 const pending=bridge.toggleStar('file-a')
 await new Promise(resolve=>setImmediate(resolve))
 const opposite=bridge.unstarPaths(['file-a']).then(()=>null,error=>error)
 finish();await pending
 assert.match((await opposite)?.message??'',/进行中/)
 await bridge.unstarPaths(['file-a'])
 assert.deepEqual(writes,[true,false]);assert.equal(starred,false)
})

for(const status of [undefined,408,503])test(`unknown star (${status}) reconciles its original target instead of reversing a committed write`,async()=>{
 let starred=false,changed=0;const writes=[]
 const bridge=createLocalHomeBridge({...deps(async(_path,method,body)=>{
  if(method==='PUT'){starred=body.starred;writes.push(body.starred);throw Object.assign(Error('response lost'),{status})}
  return {files:[{...item,starred}],total:1,totalAll:1}
 }),changed:()=>changed++})
 await assert.rejects(bridge.toggleStar(item.id),/再次点击将核对收藏/)
 assert.equal(changed,0)
 await bridge.toggleStar(item.id)
 assert.deepEqual(writes,[true]);assert.equal(starred,true);assert.equal(changed,1)
})
test('uncommitted unknown star retries only its original absolute target and rejects an opposite explicit intent',async()=>{
 let starred=false,fail=true;const writes=[]
 const bridge=createLocalHomeBridge(deps(async(_path,method,body)=>{
  if(method==='PUT'){writes.push(body.starred);if(fail){fail=false;throw Error('lost before commit')}starred=body.starred;return}
  return {files:[{...item,starred}],total:1,totalAll:1}
 }))
 await assert.rejects(bridge.toggleStar(item.id),/再次点击将核对收藏/)
 await assert.rejects(bridge.unstarPaths([item.id]),/核对收藏/)
 await bridge.toggleStar(item.id)
 assert.deepEqual(writes,[true,true]);assert.equal(starred,true)
})
for(const status of [400,403,404,409,429])for(const lateCommit of [false,true])test(`reconciliation rejection (${status}, late commit ${lateCommit}) preserves an earlier unknown star target`,async()=>{
 let starred=false,changed=0;const writes=[]
 const bridge=createLocalHomeBridge({...deps(async(_path,method,body)=>{
  if(method==='PUT'){
   writes.push(body.starred)
   if(writes.length===1)throw Object.assign(Error('original response timeout'),{status:408})
   if(writes.length===2){if(lateCommit)starred=true;throw Object.assign(Error('retry rejected'),{status})}
   starred=body.starred;return
  }
  return {files:[{...item,starred}],total:1,totalAll:1}
 }),changed:()=>changed++})
 await assert.rejects(bridge.toggleStar(item.id),/再次点击将核对收藏/)
 await assert.rejects(bridge.toggleStar(item.id),/retry rejected/)
 assert.equal(changed,0)
 await bridge.toggleStar(item.id)
 assert.deepEqual(writes,lateCommit?[true,true]:[true,true,true])
 assert.equal(starred,true);assert.equal(changed,1)
 // Only an authoritative matching read or successful absolute write clears uncertainty.
 await bridge.toggleStar(item.id)
 assert.deepEqual(writes,lateCommit?[true,true,false]:[true,true,true,false])
 assert.equal(starred,false);assert.equal(changed,2)
})
test('definite rejected star releases its target so a later click follows the latest server state',async()=>{
 let starred=false,fail=true;const writes=[]
 const bridge=createLocalHomeBridge(deps(async(_path,method,body)=>{
  if(method==='PUT'){writes.push(body.starred);if(fail){fail=false;throw Object.assign(Error('forbidden'),{status:403})}starred=body.starred;return}
  return {files:[{...item,starred}],total:1,totalAll:1}
 }))
 await assert.rejects(bridge.toggleStar(item.id),/forbidden/);starred=true
 await bridge.toggleStar(item.id);assert.deepEqual(writes,[true,false])
})
test('unknown unstar target survives a reconciliation read failure without reporting success or reversing',async()=>{
 let starred=true,readFails=false,changed=0;const writes=[]
 const bridge=createLocalHomeBridge({...deps(async(_path,method,body)=>{
  if(method==='PUT'){starred=body.starred;writes.push(body.starred);throw Error('lost after commit')}
  if(readFails)throw Object.assign(Error('read unavailable'),{status:503})
  return {files:[{...item,starred}],total:1,totalAll:1}
 }),changed:()=>changed++})
 await assert.rejects(bridge.toggleStar(item.id),/再次点击将核对收藏/)
 readFails=true;await assert.rejects(bridge.toggleStar(item.id),/再次点击将核对收藏/);assert.equal(changed,0)
 readFails=false;await bridge.toggleStar(item.id);assert.equal(changed,1);assert.deepEqual(writes,[false]);assert.equal(starred,false)
})
for(const action of ['rename','move'])test(`different ${action} intents for the same file are rejected while the first is pending`,async()=>{
 let finish;const gate=new Promise(resolve=>finish=resolve),writes=[]
 const bridge=createLocalHomeBridge(deps(async(_path,_method,body)=>{writes.push(body);await gate}))
 const first=action==='rename'?bridge.renameFile(item.id,'First.docx'):bridge.movePaths([item.id],'/workspace/first','ask')
 await new Promise(resolve=>setImmediate(resolve))
 const second=(action==='rename'?bridge.renameFile(item.id,'Second.docx'):bridge.movePaths([item.id],'/workspace/second','ask')).then(value=>({value}),error=>({error}))
 await new Promise(resolve=>setImmediate(resolve));finish();await first
 const outcome=await second
 if(action==='rename')assert.match(outcome.error?.message??'',/进行中/)
 else assert.match(outcome.value.failed[0]?.error??'',/进行中/)
 assert.equal(writes.length,1)
})

for(const action of ['removeRecent','unstarPaths'])test(`${action} resumes partial batches with read-only unknown reconciliation and never rewrites confirmed items`,async()=>{
 const writes=[];let unknown=true,achieved=false
 const bridge=createLocalHomeBridge(deps(async(path,method)=>{
  if(method){writes.push(path);if(path.includes('/b')&&unknown){unknown=false;throw Error('lost response')}return}
  const id=new URL(path,'http://local').searchParams.get('id')
  const found=action==='removeRecent'?!achieved:true
  return {files:found?[{...item,id,starred:!achieved}]:[],total:found?1:0,totalAll:found?1:0}
 }))
 await assert.rejects(bridge[action](['a','b','c']),/待核对/)
 assert.equal(writes.length,2)
 await assert.rejects(bridge[action](['c','b','a']),/待核对/);assert.equal(writes.length,2)
 await assert.rejects(bridge[action](['b','other']),/待核对/);assert.equal(writes.length,2)
 achieved=true;await bridge[action](['c','b','a'])
 assert.equal(writes.length,3);assert.ok(writes[2].includes('/c'))
 // Full completion releases the old batch: a later restore/open/star then new action is a new intent.
 await bridge[action](['a','b','c']);assert.equal(writes.length,6)
})
test('42 selected files use one batch write and one refresh, including double confirmation',async()=>{
 const requests=[], ids=Array.from({length:42},(_,i)=>String(i).padStart(2,'0'))
 let refresh=0
 const bridge=createLocalHomeBridge({...deps(async(path,method,body)=>requests.push({path,method,body})),changed:()=>refresh++})
 await Promise.all([bridge.deleteFiles(ids),bridge.deleteFiles([...ids].reverse())])
 assert.deepEqual(requests,[{path:'/api/v1/files/trash-batch',method:'POST',body:{ids}}])
 assert.equal(refresh,1)
})
test('rate limited batch explains the rejection and leaves selection retryable',async()=>{
 let requests=0
 const bridge=createLocalHomeBridge(deps(async()=>{if(++requests===1)throw Object.assign(Error('Too Many Requests'),{status:429})}))
 await assert.rejects(bridge.deleteFiles(['a','b']),/本次请求未移动文件/)
 await bridge.deleteFiles(['a','b'])
 assert.equal(requests,2)
})
test('bulk unstar unknown cannot be bypassed by toggle or by a failed reconciliation read',async()=>{
 let readsFail=false,starred=true;const writes=[]
 const bridge=createLocalHomeBridge(deps(async(path,method,body)=>{
  if(method){writes.push(body);throw Object.assign(Error('timeout'),{status:408})}
  if(readsFail)throw Error('offline')
  return {files:[{...item,starred}],total:1,totalAll:1}
 }))
 await assert.rejects(bridge.unstarPaths([item.id]),/待核对/)
 readsFail=true;await assert.rejects(bridge.unstarPaths([item.id]),/待核对/)
 readsFail=false;await assert.rejects(bridge.toggleStar(item.id),/待核对/);assert.equal(writes.length,1)
 starred=false;await bridge.toggleStar(item.id);assert.equal(writes.length,1)
})
test('lost batch response reconciles an overlapping selection before retrying remaining files',async()=>{
 const writes=[], reads=[]
 let connected=false
 const bridge=createLocalHomeBridge(deps(async(path,method,{ids})=>{
   if(path.endsWith('/status')){reads.push(ids);if(!connected)throw Error('offline');return {active:['b']}}
   writes.push(ids);if(writes.length===1)throw Error('lost')
 }))
 await assert.rejects(bridge.deleteFiles(['a','b','c']),/尚未确认/)
 await assert.rejects(bridge.deleteFiles(['a','b','d']),/无法核对/)
 connected=true
 await bridge.deleteFiles(['a','b','d'])
 assert.deepEqual(writes,[['a','b','c'],['b','d']])
 assert.deepEqual(reads,[['a','b'],['a','b']])
})
for(const action of ['removeRecent','unstarPaths'])test(`${action} rechecks a confirmed item reversed by restore, reopen or star before resuming`,async()=>{
 const writes=[];let fail=true,reversed=false,readFails=false
 const bridge=createLocalHomeBridge(deps(async(path,method)=>{
  if(method){writes.push(path);if(path.includes('/b')&&fail){fail=false;throw Object.assign(Error('forbidden'),{status:403})}return}
  if(readFails)throw Error('offline')
  const id=new URL(path,'http://local').searchParams.get('id'),found=action==='removeRecent'?reversed:true
  return {files:found?[{...item,id,starred:reversed}]:[],total:found?1:0,totalAll:found?1:0}
 }))
 await assert.rejects(bridge[action](['a','b']),/forbidden/)
 readFails=true;await assert.rejects(bridge[action](['a','b']),/待核对/);assert.equal(writes.length,2)
 readFails=false;reversed=true;await bridge[action](['a','b'])
 assert.equal(writes.length,4);assert.ok(writes[2].includes('/a'));assert.ok(writes[3].includes('/b'))
})


test('recent page and count stay one bounded server query regardless of workspace size',async()=>{
 const calls=[];const bridge=createLocalHomeBridge(deps(async path=>{calls.push(path);if(calls.length>1)throw new Error('unbounded scan');return {files:[],total:100000,totalAll:200000}}))
 assert.deepEqual(await bridge.recents({offset:50,limit:0,ext:'xlsx'}),{entries:[],total:100000,totalAll:200000})
 const url=new URL(calls[0],'https://local');assert.equal(url.searchParams.get('offset'),'50');assert.equal(url.searchParams.get('limit'),'0');assert.equal(url.searchParams.get('family'),'spreadsheet');assert.equal(url.searchParams.has('ext'),false)
})
for(const view of ['recents','starred'])test(`${view} refreshes more than 100 loaded rows using valid bounded API pages`,async()=>{
 const calls=[],items=Array.from({length:175},(_,i)=>({...item,id:`file-${i}`,name:`file-${i}.docx`}))
 const bridge=createLocalHomeBridge(deps(async path=>{
  const url=new URL(path,'http://local'),limit=Number(url.searchParams.get('limit')),offset=Number(url.searchParams.get('offset'))
  calls.push({limit,offset,ext:url.searchParams.get('ext')});if(limit>100)throw Object.assign(Error('invalid limit'),{status:400})
  return {files:items.slice(offset,offset+limit),total:175,totalAll:200}
 }))
 const page=await bridge[view]({offset:10,limit:150,ext:'docx'})
 assert.equal(page.entries.length,150);assert.equal(new Set(page.entries.map(file=>file.path)).size,150)
 assert.deepEqual(page.entries.map(file=>file.path),items.slice(10,160).map(file=>file.id))
 assert.deepEqual(calls,[{limit:100,offset:10,ext:'docx'},{limit:50,offset:110,ext:'docx'}])
 assert.equal(page.total,175);assert.equal(page.totalAll,200)
})
for(const changed of ['total','overlap','empty'])test(`a multi-page refresh rejects ${changed} changes without publishing a partial list`,async()=>{
 let reads=0
 const bridge=createLocalHomeBridge(deps(async()=>{
  reads++
  const files=Array.from({length:reads===1?100:changed==='empty'?0:50},(_,i)=>({...item,id:`file-${reads===1||changed==='overlap'?i:100+i}`}))
  return {files,total:reads>1&&changed==='total'?151:150,totalAll:200}
 }))
 await assert.rejects(bridge.recents({limit:150}),/列表已变化/)
 assert.equal(reads,2)
})
test('search delegates literal query and page to server without enumeration',async()=>{
 const calls=[];const bridge=createLocalHomeBridge(deps(async path=>{calls.push(path);if(calls.length>1)throw new Error('unbounded scan');return {files:[item],total:100000,totalAll:200000}}))
 const page=await bridge.searchFiles({q:'%_报告',offset:20,limit:10,ext:'docx'})
 assert.equal(page.total,100000);assert.equal(page.hits.length,1)
 const url=new URL(calls[0],'https://local');assert.equal(url.searchParams.get('q'),'%_报告');assert.equal(url.searchParams.get('offset'),'20');assert.equal(url.searchParams.get('limit'),'10')
})
test('toggle and stat query only specified file identities',async()=>{
 const calls=[];const bridge=createLocalHomeBridge(deps(async(path,method)=>{calls.push([path,method]);return {files:[item],total:1,totalAll:100000}}))
 await bridge.toggleStar(item.id);await bridge.statPaths([item.id,item.id])
 const reads=calls.filter(([,m])=>!m);assert.equal(reads.length,2)
 for(const [path] of reads){const url=new URL(path,'https://local');assert.equal(url.searchParams.get('id'),item.id);assert.equal(url.searchParams.get('limit'),'1')}
})

test('reveal resolves a file parent inside the workspace and never invokes a native operation',async()=>{
 const {onRevealWorkspaceFolder}=await import('../../../../apps/shell/src/renderer/src/file-events.ts')
 const events=[],calls=[]
 const stop=onRevealWorkspaceFolder(target=>events.push(target))
 const bridge=createLocalHomeBridge({...deps(async path=>{calls.push(path);return path.endsWith('/folders')?{folders:[{id:'parent',parentId:null,name:'Projects'},{id:'child',parentId:'parent',name:'Reports'}]}:{files:[{...item,folderId:'child'}],total:1,totalAll:1}}),unsupported:()=>assert.fail('native fallback must not run')})
 try{await bridge.revealPath(item.id);assert.deepEqual(events,[{dir:'/workspace/parent/child',fileId:item.id}]);assert.equal(calls.length,2)}finally{stop()}
})

test('reveal supports a root file and an existing virtual folder but rejects missing targets without navigation',async()=>{
 const {onRevealWorkspaceFolder}=await import('../../../../apps/shell/src/renderer/src/file-events.ts')
 const events=[];const stop=onRevealWorkspaceFolder(target=>events.push(target))
 const bridge=createLocalHomeBridge(deps(async path=>path.endsWith('/folders')?{folders:[{id:'parent',parentId:null,name:'Projects'}]}:{files:path.includes('id=missing')?[]:[item],total:path.includes('id=missing')?0:1,totalAll:1}))
 try{
  await bridge.revealPath(item.id);await bridge.revealPath('/workspace/parent');await bridge.revealPath('/workspace')
  assert.deepEqual(events,[{dir:'/workspace',fileId:item.id},{dir:'/workspace/parent'},{dir:'/workspace'}])
  await assert.rejects(bridge.revealPath('missing'),/不存在/)
  await assert.rejects(bridge.revealPath('/workspace/removed'),/不存在/)
  assert.equal(events.length,3)
 }finally{stop()}
})

test('reveal switches back to Home before dispatching navigation and rejects an orphaned file parent',async()=>{
 const {onRevealWorkspaceFolder}=await import('../../../../apps/shell/src/renderer/src/file-events.ts')
 const order=[];const stop=onRevealWorkspaceFolder(()=>order.push('reveal'))
 const previous=globalThis.window
 globalThis.window={aiOfficeTabs:{activate:async id=>order.push(id)}}
 let parent=null
 const bridge=createLocalHomeBridge(deps(async path=>path.endsWith('/folders')?{folders:[]}:{files:[{...item,folderId:parent}],total:1,totalAll:1}))
 try{await bridge.revealPath(item.id);assert.deepEqual(order,['home','reveal']);parent='removed';await assert.rejects(bridge.revealPath(item.id),/文件夹不存在/);assert.equal(order.length,2)}finally{stop();if(previous===undefined)delete globalThis.window;else globalThis.window=previous}
})

test('root locations are localized and require no folder enumeration',async()=>{
 for(const [language,label] of [['zh','个人文件'],['en','My files']]){
  const calls=[]
  const bridge=createLocalHomeBridge({...deps(async path=>{calls.push(path);return {files:[item],total:1,totalAll:1}}),preferences:{...prefs,getPreferences:async()=>({language})}})
  assert.equal((await bridge.recents()).entries[0].locationLabel,label)
  assert.equal(calls.length,1)
 }
})
test('all file projections resolve unopened folder ancestry by names without changing file identity',async()=>{
 const folders=[{id:'parent-id',name:'Parent',parentId:null},{id:'child-id',name:'Child',parentId:'parent-id'}]
 const nested={...item,folderId:'child-id'}
 const bridge=createLocalHomeBridge(deps(async path=>path.endsWith('/folders')?{folders}:{files:[nested],total:1,totalAll:1}))
 const entries=[(await bridge.recents()).entries[0],(await bridge.starred()).entries[0],(await bridge.statPaths([item.id]))[0],(await bridge.searchFiles({q:'one'})).hits[0],(await bridge.listFolder('/workspace/parent-id/child-id')).files[0]]
 for(const entry of entries){assert.equal(entry.locationLabel,'Parent / Child');assert.equal(entry.path,item.id);assert.ok(!entry.locationLabel.includes('-id'))}
})
test('fresh queries resolve renamed and moved folders and moved files without stale location caches',async()=>{
 const folders=[{id:'parent',name:'Parent',parentId:null},{id:'child',name:'Child',parentId:'parent'}]
 const nested={...item,folderId:'child'}
 const bridge=createLocalHomeBridge(deps(async(path,method,body)=>{
  if(method==='PATCH'){
   if(path.endsWith('/folders/parent'))folders[0].name=body.name
   else if(path.endsWith('/folders/child'))folders[1].parentId=body.parentId
   else if(path.endsWith('/folder'))nested.folderId=body.folderId
   return {}
  }
  return path.endsWith('/folders')?{folders}:{files:[nested],total:1,totalAll:1}
 }))
 assert.equal((await bridge.recents()).entries[0].locationLabel,'Parent / Child')
 await bridge.renameFolder('/workspace/parent','Renamed')
 assert.equal((await bridge.recents()).entries[0].locationLabel,'Renamed / Child')
 await bridge.movePaths(['/workspace/parent/child'],'/workspace','ask')
 assert.equal((await bridge.searchFiles({q:'one'})).hits[0].locationLabel,'Child')
 await bridge.movePaths([item.id],'/workspace','ask')
 assert.equal((await bridge.recents()).entries[0].locationLabel,'个人文件')
})
test('missing or cyclic folder ancestry is explicitly unavailable rather than root or opaque IDs',async()=>{
 for(const folders of [[],[{id:'child',name:'Child',parentId:'missing'}],[{id:'child',name:'Child',parentId:'child'}]]){
  const bridge=createLocalHomeBridge(deps(async path=>path.endsWith('/folders')?{folders}:{files:[{...item,folderId:'child'}],total:1,totalAll:1}))
  assert.equal((await bridge.recents()).entries[0].locationLabel,'位置不可用')
  assert.equal((await bridge.searchFiles({q:'one'})).hits[0].locationLabel,'位置不可用')
 }
})

test('successful rename notifies the host once; rejected rename never changes an open title',async()=>{
 const renamed=[];let finish,fail=false
 const gate=new Promise(resolve=>{finish=resolve})
 const bridge=createLocalHomeBridge({...deps(async()=>{await gate;if(fail)throw Error('rename rejected')}),renamed:(id,name)=>renamed.push({id,name})})
 const first=bridge.renameFile('file-a','new.docx'),duplicate=bridge.renameFile('file-a','new.docx')
 assert.deepEqual(renamed,[]);finish();await Promise.all([first,duplicate])
 assert.deepEqual(renamed,[{id:'file-a',name:'new.docx'}])
 fail=true;await assert.rejects(bridge.renameFile('file-a','rejected.docx'),/rename rejected/)
 assert.deepEqual(renamed,[{id:'file-a',name:'new.docx'}])
})

for(const view of ['recents','starred'])test(`${view} forwards explicit modified sort across bounded refresh pages and preserves server order`,async()=>{
 const calls=[],items=Array.from({length:170},(_,i)=>({...item,id:`sort-${String(i).padStart(3,'0')}`,name:`${i}.docx`}))
 const bridge=createLocalHomeBridge(deps(async path=>{
  const query=new URL(path,'http://localhost').searchParams;calls.push(query)
  const ordered=query.get('sort')==='modified-asc'?[...items].reverse():items
  return {files:ordered.slice(Number(query.get('offset')),Number(query.get('offset'))+Number(query.get('limit'))),total:170,totalAll:170}
 }))
 const page=await bridge[view]({offset:10,limit:150,ext:'docx',sort:'modified-asc'})
 assert.deepEqual(page.entries.map(entry=>entry.path),[...items].reverse().slice(10,160).map(item=>item.id))
 assert.deepEqual(calls.map(q=>({sort:q.get('sort'),offset:q.get('offset'),limit:q.get('limit'),ext:q.get('ext')})),[{sort:'modified-asc',offset:'10',limit:'100',ext:'docx'},{sort:'modified-asc',offset:'110',limit:'50',ext:'docx'}])
 calls.length=0;await bridge[view]({limit:1});assert.equal(calls[0].has('sort'),false)
})

for(const stage of ['folders','file','activate'])test(`已取消的位置导航在 ${stage} 等待结束后不继续查询或通知`,async()=>{
 const {onRevealWorkspaceFolder}=await import('../../../../apps/shell/src/renderer/src/file-events.ts')
 const gate=Promise.withResolvers(),started=Promise.withResolvers(),controller=new AbortController(),calls=[],events=[]
 let changed=0
 const previous=globalThis.window
 globalThis.window={aiOfficeTabs:{activate:async()=>{calls.push('activate');if(stage==='activate'){started.resolve();await gate.promise}}}}
 const stop=onRevealWorkspaceFolder(event=>events.push(event))
 const bridge=createLocalHomeBridge({...deps(async path=>{
  const phase=path.endsWith('/folders')?'folders':'file';calls.push(phase)
  if(stage===phase){started.resolve();await gate.promise}
  return phase==='folders'?{folders:[]}:{files:[item],total:1,totalAll:1}
 }),changed:()=>changed++})
 try{
  const pending=bridge.revealPath(item.id,controller.signal);await started.promise;controller.abort();gate.resolve()
  await assert.rejects(pending,{name:'AbortError'})
  assert.deepEqual(calls,stage==='folders'?['folders']:stage==='file'?['folders','file']:['folders','file','activate'])
  assert.equal(changed,0);assert.deepEqual(events,[])
 }finally{gate.resolve();stop();if(previous===undefined)delete globalThis.window;else globalThis.window=previous}
})

test('位置父读取失败后可原位重试，未取消操作仍会报告失败',async()=>{
 const {onRevealWorkspaceFolder}=await import('../../../../apps/shell/src/renderer/src/file-events.ts')
 const events=[];let fail=true
 const stop=onRevealWorkspaceFolder(event=>events.push(event))
 const bridge=createLocalHomeBridge(deps(async path=>{
  if(path.endsWith('/folders')){if(fail){fail=false;throw new Error('parent unavailable')}return {folders:[]}}
  return {files:[item],total:1,totalAll:1}
 }))
 try{await assert.rejects(bridge.revealPath(item.id),/parent unavailable/);assert.deepEqual(events,[]);await bridge.revealPath(item.id);assert.deepEqual(events,[{dir:'/workspace',fileId:item.id}])}finally{stop()}
})
