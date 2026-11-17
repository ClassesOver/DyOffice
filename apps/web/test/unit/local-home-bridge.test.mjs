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


test('recent page and count stay one bounded server query regardless of workspace size',async()=>{
 const calls=[];const bridge=createLocalHomeBridge(deps(async path=>{calls.push(path);if(calls.length>1)throw new Error('unbounded scan');return {files:[],total:100000,totalAll:200000}}))
 assert.deepEqual(await bridge.recents({offset:50,limit:0,ext:'xlsx'}),{entries:[],total:100000,totalAll:200000})
 const url=new URL(calls[0],'https://local');assert.equal(url.searchParams.get('offset'),'50');assert.equal(url.searchParams.get('limit'),'0');assert.equal(url.searchParams.get('ext'),'xlsx')
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
