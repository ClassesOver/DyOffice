import {expect,test} from 'vitest'
import {createEntryRecovery,parseEntryHash,entryHash} from '../../src/shell/workspace-entry-recovery'
const id='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222'
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
