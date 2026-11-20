import {expect,test} from 'vitest'
import {createSourcesClient} from '../../src/shell/sources-client'
const detail=(sourceId:string)=>({source:{sourceId,name:sourceId},config:{}})
for(const action of ['create','save','remove'] as const)test(`${action} unknown fence can only be acknowledged after reading the affected identity`,async()=>{
 let writes=0
 const client=createSourcesClient((async(path:string,method='GET')=>{if(method!=='GET'){writes++;throw Error('lost')}return detail(path.split('/').pop()!)}) as never)
 await expect(action==='create'?client.create({sourceId:'a'} as never):action==='save'?client.save('a',{} as never):client.remove('a',1)).rejects.toThrow()
 expect(client.getState().unknownWrite).toBe(true)
 await client.detail('b');client.acknowledgeLatest('b');expect(client.getState().unknownWrite).toBe(true)
 await client.detail('a');client.acknowledgeLatest('a');expect(client.getState().unknownWrite).toBe(false);expect(writes).toBe(1)
})
test('a mismatched detail response cannot release an unknown write',async()=>{
 const client=createSourcesClient((async(_path:string,method='GET')=>{if(method!=='GET')throw Error('lost');return detail('b')}) as never)
 await expect(client.save('a',{expectedVersion:1})).rejects.toThrow();await expect(client.detail('a')).rejects.toThrow()
 client.acknowledgeLatest('a');expect(client.getState().unknownWrite).toBe(true)
})
test('only an explicit read of the affected missing identity can reconcile a deletion',async()=>{
 const client=createSourcesClient((async(_path:string,method='GET')=>{if(method!=='GET')throw Error('lost');throw Object.assign(Error('missing'),{status:404})}) as never)
 await expect(client.remove('a',1)).rejects.toThrow()
 client.acknowledgeLatest('a');expect(client.getState().unknownWrite).toBe(true)
 await expect(client.detail('b')).rejects.toThrow();client.acknowledgeLatest('b');expect(client.getState().unknownWrite).toBe(true)
 await expect(client.detail('a')).rejects.toThrow();client.acknowledgeLatest('a');expect(client.getState().unknownWrite).toBe(false)
})
test('testing a connection is read-only and cannot acknowledge an unknown write',async()=>{
 const client=createSourcesClient((async(path:string)=>{if(path.endsWith('/a'))throw Error('lost');return {ok:true}}) as never)
 await expect(client.save('a',{expectedVersion:1})).rejects.toThrow();await client.test('a');client.acknowledgeLatest('a');expect(client.getState().unknownWrite).toBe(true)
})
