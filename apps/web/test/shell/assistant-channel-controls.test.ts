import {act,createElement as h} from 'react'
import {createRoot} from 'react-dom/client'
import {afterEach,beforeEach,expect,test,vi} from 'vitest'
import {AssistantChannelPanel} from '../../src/editors/assistant-channel-panel'

;(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true
let host:HTMLDivElement,root:ReturnType<typeof createRoot>
beforeEach(()=>{host=document.createElement('div');document.body.append(host);root=createRoot(host)})
afterEach(async()=>{await act(async()=>root.unmount());host.remove()})
function fixture(){
 let snapshot={conversationId:'channel',fileId:'file',paused:false,sequence:1,members:[{membershipId:'peer',displayName:'Peer',kind:'custom',online:true,revoked:false}],applications:[],tasks:[{taskId:'task-1',instruction:'Read document',state:'running'}]}
 const listeners=new Set<()=>void>()
 const client={snapshot:()=>snapshot,subscribe(listener:()=>void){listeners.add(listener);return()=>listeners.delete(listener)},error:()=>'',start:vi.fn(async()=>{}),invite:vi.fn(async()=>({inviteToken:'private-invite',expiresAt:new Date(Date.now()+60000).toISOString()})),approve:vi.fn(async()=>{}),remove:vi.fn(async()=>{}),pause:vi.fn(async()=>{}),send:vi.fn(async()=>{}),cancel:vi.fn(async()=>{}),refresh:vi.fn(async()=>{})}
 return {client,async emit(patch:Partial<typeof snapshot>){snapshot={...snapshot,...patch};await act(async()=>listeners.forEach(listener=>listener()))}}
}
const button=(text:string)=>[...host.querySelectorAll('button')].find(node=>node.textContent===text)!
const input=(node:HTMLTextAreaElement,value:string)=>{const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!;setter.call(node,value);node.dispatchEvent(new Event('input',{bubbles:true}))}
async function mount(client:unknown){await act(async()=>root.render(h('div',{},h('textarea',{'aria-label':'Native draft',defaultValue:'Unsent native draft'}),h(AssistantChannelPanel,{client:client as never,lang:'en'}))))}

test('cancel requests do not claim cancellation until a durable snapshot confirms it',async()=>{
 const f=fixture();await mount(f.client)
 const native=host.querySelector<HTMLTextAreaElement>('[aria-label="Native draft"]')!
 await act(async()=>button('Cancel task').click())
 expect(f.client.cancel).toHaveBeenCalledWith('task-1')
 expect(host.textContent).toContain('Running')
 expect(host.textContent).not.toContain('Cancelled')
 await f.emit({tasks:[{taskId:'task-1',instruction:'Read document',state:'cancel_requested'}]})
 expect(host.textContent).toContain('Cancelling')
 expect(host.textContent).not.toContain('Cancelled')
 await f.emit({tasks:[{taskId:'task-1',instruction:'Read document',state:'cancelled'}]})
 expect(host.textContent).toContain('Cancelled')
 expect(host.querySelector('[aria-label="Native draft"]')).toBe(native)
 expect(native.value).toBe('Unsent native draft')
})

test('failed peer sends keep both local drafts and leave the Office composer mounted',async()=>{
 const f=fixture();f.client.send.mockRejectedValueOnce(Error('private backend details'));await mount(f.client)
 const native=host.querySelector<HTMLTextAreaElement>('[aria-label="Native draft"]')!
 const peer=host.querySelector<HTMLTextAreaElement>('form textarea')!
 await act(async()=>input(peer,'Question for peer'))
 await act(async()=>host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})))
 expect(f.client.send).toHaveBeenCalledWith('peer','Question for peer')
 expect(peer.value).toBe('Question for peer')
 expect(native.value).toBe('Unsent native draft')
 expect(host.querySelector('[role="alert"]')?.textContent).toContain('did not finish')
 expect(host.textContent).not.toContain('private backend details')
 expect(host.querySelector('form textarea')).toBe(peer)
})

test('pause affects collaboration only and invitations disappear on collapse',async()=>{
 const f=fixture();await mount(f.client)
 await act(async()=>button('Pause collaboration').click())
 expect(f.client.pause).toHaveBeenCalledWith(true)
 await f.emit({paused:true})
 expect(button('Resume collaboration')).toBeTruthy()
 expect(host.querySelector<HTMLTextAreaElement>('[aria-label="Native draft"]')!.disabled).toBe(false)
 await act(async()=>button('Create invitation').click())
 expect(host.textContent).toContain('private-invite')
 await act(async()=>button('Collapse').click())
 expect(host.textContent).not.toContain('private-invite')
 expect(host.querySelector<HTMLTextAreaElement>('[aria-label="Native draft"]')!.value).toBe('Unsent native draft')
})
