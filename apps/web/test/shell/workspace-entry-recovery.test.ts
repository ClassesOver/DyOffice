import {expect,test} from 'vitest'
import {createEntryRecovery,parseEntryHash,entryHash,workspaceFileLink} from '../../src/shell/workspace-entry-recovery'
const id='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222'
test('copied workspace links address the file without inheriting page parameters',()=>{
 expect(workspaceFileLink(id,'https://office.example/?panel=channels#private')).toBe('https://office.example/#/file/'+id)
 expect(()=>workspaceFileLink('../other','https://office.example/')).toThrow()
})
function storage(){const data=new Map<string,string>();return {data,getItem:(k:string)=>data.get(k)??null,setItem:(k:string,v:string)=>{data.set(k,v)},removeItem:(k:string)=>{data.delete(k)}}}
test('snapshot contains only bounded IDs and isolates accounts and deployments',()=>{
 const s=storage(),r=createEntryRecovery(s,'deployment-a','alice');r.save([id,other],other)
 expect(r.read()).toEqual({ids:[id,other],active:other});expect([...s.data.values()][0]).toBe(JSON.stringify({version:1,ids:[id,other],active:other}))
 expect(createEntryRecovery(s,'deployment-a','bob').read()).toEqual({ids:[],active:'home'})
 expect(createEntryRecovery(s,'deployment-b','alice').read()).toEqual({ids:[],active:'home'})
 r.clear();expect(r.read()).toEqual({ids:[],active:'home'})
})
test('corrupt, oversized, duplicate and unsafe snapshots fail closed; quota failures do not break navigation',()=>{
 const s=storage(),r=createEntryRecovery(s,'d','u');r.save([id],id);const key=[...s.data.keys()][0]
 for(const value of ['{',JSON.stringify({version:1,ids:[id,id],active:id}),JSON.stringify({version:1,ids:['../../x'],active:'home'}),'x'.repeat(8193)]){s.setItem(key,value);expect(r.read()).toEqual({ids:[],active:'home'})}
 const bad={getItem(){throw Error()},setItem(){throw Error()},removeItem(){throw Error()}}
 const q=createEntryRecovery(bad,'d','u');expect(q.read()).toEqual({ids:[],active:'home'});expect(()=>q.save([id],id)).not.toThrow();expect(()=>q.clear()).not.toThrow()
})
test('snapshot prioritizes pinned IDs within the bound and restores only authorized pins',async()=>{
 const s=storage(),r=createEntryRecovery(s,'d','u')
 const ids=Array.from({length:23},(_,i)=>`${String(i).padStart(8,'0')}-1111-4111-8111-111111111111`)
 r.save(ids,ids[22],[ids[0],ids[21],other])
 expect(r.read().ids).toHaveLength(20)
 expect(r.read().pinned).toEqual([ids[0],ids[21]])
 expect(r.read().active).toBe(ids[22])
 const {resolveEntrySnapshot}=await import('../../src/shell/workspace-entry-recovery')
 const restored=await resolveEntrySnapshot(r.read(),undefined,async id=>{
  if(id===ids[21])throw Object.assign(Error(),{status:404})
  return {id}
 })
 expect(restored.pinned).toEqual([ids[0]])
 const linked=await resolveEntrySnapshot(r.read(),other,async id=>({id}))
 expect(linked.entries).toHaveLength(20)
 expect(linked.active).toBe(other)
 expect(linked.pinned).toEqual([ids[0],ids[21]])
})
test('URL accepts only document IDs or home, never paths or credentials',()=>{
 expect(parseEntryHash('')).toBeUndefined();expect(parseEntryHash(entryHash(id))).toBe(id)
 for(const hash of ['#/file/https://evil','#/file/%2fsecret','#/file/'+id+'?token=x','#anything'])expect(parseEntryHash(hash)).toBe('home')
})

test('restore resolves IDs through authenticated reader, preserves order, falls back from missing files and propagates session failure',async()=>{
 const {resolveEntrySnapshot}=await import('../../src/shell/workspace-entry-recovery')
 const calls:string[]=[]
 const result=await resolveEntrySnapshot({ids:[id,other],active:other},undefined,async key=>{calls.push(key);if(key===other)throw Object.assign(Error(),{status:404});return {id:key}})
 expect(calls).toEqual([id,other]);expect(result.entries).toEqual([{id}]);expect(result.active).toBe('home');expect(result.failed).toBe(1)
 await expect(resolveEntrySnapshot({ids:[id],active:id},undefined,async()=>{throw Object.assign(Error(),{code:'stale_session'})})).rejects.toMatchObject({code:'stale_session'})
})
test('saved entry limit retains the selected item and removes duplicates without retaining titles',()=>{
 const s=storage(),r=createEntryRecovery(s,'d','u')
 const ids=Array.from({length:30},(_,i)=>`${String(i).padStart(8,'0')}-1111-4111-8111-111111111111`)
 r.save([...ids,ids[0]],ids[29]);expect(r.read().ids).toHaveLength(20);expect(r.read().active).toBe(ids[29]);expect(new Set(r.read().ids).size).toBe(20)
})
test('explicit home URL overrides saved selection and a deep link is checked by the bound reader',async()=>{
 const {resolveEntrySnapshot}=await import('../../src/shell/workspace-entry-recovery')
 expect((await resolveEntrySnapshot({ids:[id],active:id},'home',async id=>({id}))).active).toBe('home')
 const seen:string[]=[]
 const result=await resolveEntrySnapshot({ids:[id],active:id},other,async id=>{seen.push(id);return {id}})
 expect(seen).toEqual([id,other]);expect(result.active).toBe(other)
})

test('split recovery keeps both panes within the entry cap and drops the layout if access or the selected route changes',async()=>{
 const s=storage(),recovery=createEntryRecovery(s,'d','u')
 const filler=Array.from({length:20},(_,i)=>`${String(i).padStart(8,'0')}-1111-4111-8111-111111111111`)
 const split={left:id,right:other,width:65}
 recovery.save([...filler,id,other],id,filler,split)
 const snapshot=recovery.read()
 expect(snapshot.ids).toHaveLength(20)
 expect(snapshot.ids).toContain(other)
 expect(snapshot.split).toEqual(split)
 const {resolveEntrySnapshot}=await import('../../src/shell/workspace-entry-recovery')
 const open=async(id:string)=>({id})
 expect((await resolveEntrySnapshot(snapshot,undefined,open)).split).toEqual(split)
 expect((await resolveEntrySnapshot(snapshot,'home',open)).split).toBeUndefined()
 expect((await resolveEntrySnapshot(snapshot,undefined,async key=>{
  if(key===other)throw Object.assign(Error(),{status:404})
  return {id:key}
 })).split).toBeUndefined()

 const key=[...s.data.keys()][0]
 s.setItem(key,JSON.stringify({...snapshot,version:1,split:{...split,width:100}}))
 expect(recovery.read().ids).toEqual(snapshot.ids)
 expect(recovery.read().split).toBeUndefined()
 recovery.save([id],'home',[],{left:'home',right:id,width:55})
 expect((await resolveEntrySnapshot(recovery.read(),'home',open)).split).toEqual({left:'home',right:id,width:55})
})

test('a fresh browser tab restores a closed workspace without replacing its own tab snapshot',()=>{
 const previous=storage(), next=storage(), browser=storage()
 const first=createEntryRecovery(previous,'d','alice',browser)
 first.save([id,other],id,[other],{left:id,right:other,width:65})
 first.checkpoint()
 const reopened=createEntryRecovery(next,'d','alice',browser)
 expect(reopened.read()).toEqual({ids:[],active:'home'})
 expect(reopened.read(true)).toEqual({ids:[id,other],active:id,pinned:[other],split:{left:id,right:other,width:65}})
 expect(createEntryRecovery(next,'d','bob',browser).read(true)).toEqual({ids:[],active:'home'})
 reopened.save([],'home')
 expect(reopened.read(true)).toEqual({ids:[],active:'home'})
 reopened.checkpoint()
 expect(browser.data.size).toBe(1)
 expect(first.read(true).active).toBe(id)
 expect(createEntryRecovery(storage(),'d','alice',browser).read(true).active).toBe(id)
 reopened.save([other],other)
 reopened.save([],'home')
 reopened.checkpoint()
 expect(createEntryRecovery(storage(),'d','alice',browser).read(true)).toEqual({ids:[],active:'home'})
 reopened.clear()
 reopened.checkpoint()
 expect(browser.data.size).toBe(1)
 expect([...browser.data.keys()][0]).toContain('generation:')
})

test('clearing recovery prevents older browser tabs from restoring or publishing their saved layout',()=>{
 const shared=storage(), oldTab=storage(), controlTab=storage()
 const stale=createEntryRecovery(oldTab,'d','alice',shared)
 const controller=createEntryRecovery(controlTab,'d','alice',shared)
 stale.save([id],id)
 stale.checkpoint()
 expect(controller.read(true).active).toBe(id)
 controller.clear()
 stale.checkpoint()
 expect(createEntryRecovery(storage(),'d','alice',shared).read(true).ids).toEqual([])
 expect(createEntryRecovery(oldTab,'d','alice',shared).read().ids).toEqual([])
 stale.save([id],id)
 stale.checkpoint()
 expect(controller.read(true).ids).toEqual([])
 controller.save([other],other)
 controller.checkpoint()
 expect(createEntryRecovery(storage(),'d','alice',shared).read(true).active).toBe(other)
 stale.resume()
 stale.save([id],id)
 stale.checkpoint()
 expect(controller.read(true).active).toBe(other)
 expect(createEntryRecovery(storage(),'d','alice',shared).read(true).active).toBe(id)
})

test('restoring a split accepts Home on the right of the active document',async()=>{
 const previous=storage()
 const recovery=createEntryRecovery(previous,'d','alice')
 const split={left:id,right:'home',width:60}
 recovery.save([id],id,[],split)
 const {resolveEntrySnapshot}=await import('../../src/shell/workspace-entry-recovery')
 expect((await resolveEntrySnapshot(recovery.read(),undefined,async id=>({id}))).split).toEqual(split)
})
