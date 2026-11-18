import {expect,test,vi} from 'vitest'
import {createDraftCopyAuthority,draftCopyParentActive} from '../../src/editors/draft-copy-authority'
const proof='a'.repeat(43),other='b'.repeat(43)
test('original proof only; cookie switch permanently fails closed',async()=>{
 let token=proof
 const send=vi.fn(async(path:RequestInfo|URL,init?:RequestInit)=>{
  expect(path).toBe('/api/v1/auth/session-proof');expect(init?.method).toBe('GET');expect(init?.credentials).toBe('same-origin')
  return new Response(JSON.stringify({csrfToken:token}),{headers:{'content-type':'application/json'}})
 })
 const access=await createDraftCopyAuthority(()=>true,send)
 expect(await access.verify()).toBe(true)
 token=other;expect(await access.verify()).toBe(false)
 token=proof;expect(await access.verify()).toBe(false);expect(send).toHaveBeenCalledTimes(3)
})
test('recovery during async proof check cannot grant authority',async()=>{
 let active=true,release!:()=>void,calls=0
 const wait=new Promise<void>(r=>release=r)
 const send=vi.fn(async()=>{if(calls++)await wait;return new Response(JSON.stringify({csrfToken:proof}))})
 const access=await createDraftCopyAuthority(()=>active,send),pending=access.verify()
 active=false;release();expect(await pending).toBe(false)
 active=true;expect(await access.verify()).toBe(false)
})
test('missing parent grant, detached frame and cross-origin access refuse',()=>{
 const parent={} as Window
 for(const frame of [null,{isConnected:true,ownerDocument:{defaultView:parent}},{isConnected:false,ownerDocument:{defaultView:parent},dyofficeDraftCopySessionActive:()=>true}]){
  expect(draftCopyParentActive({parent,frameElement:frame} as unknown as Window)).toBe(false)
 }
 expect(draftCopyParentActive({parent,get frameElement(){throw Error('cross origin')}} as unknown as Window)).toBe(false)
})
test('same-origin live frame consults explicit Shell grant; top-level is allowed',()=>{
 let active=true;const parent={} as Window
 const frame={isConnected:true,ownerDocument:{defaultView:parent},dyofficeDraftCopySessionActive:()=>active}
 expect(draftCopyParentActive({parent,frameElement:frame} as unknown as Window)).toBe(true)
 active=false;expect(draftCopyParentActive({parent,frameElement:frame} as unknown as Window)).toBe(false)
 const top={} as Window;Object.assign(top,{parent:top});expect(draftCopyParentActive(top)).toBe(true)
})
test('failed initial binding never retries or switches accounts',async()=>{
 const send=vi.fn(async()=>new Response('{}',{status:401}))
 const access=await createDraftCopyAuthority(()=>true,send)
 expect(access.current()).toBe(false);expect(await access.verify()).toBe(false);expect(send).toHaveBeenCalledTimes(1)
})
