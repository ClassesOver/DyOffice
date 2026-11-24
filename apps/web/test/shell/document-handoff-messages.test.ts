import {act,createElement as h} from 'react'
import {createRoot} from 'react-dom/client'
import {expect,test,vi} from 'vitest'
import {bindDocumentHandoff} from '@genoffice/agent-core'
import * as handoff from '../../src/editors/document-handoff'

test.each(['saved','failed','resetWhileWriting'])('new chat clears %s DSH messages without changing the job receipt',async(outcome)=>{
 const peer={postMessage:vi.fn()},transport={stream:vi.fn()}
 vi.stubGlobal('opener',peer)
 vi.stubGlobal('fetch',vi.fn(async(url:string)=>Response.json(url.endsWith('/csrf')?{csrfToken:'test'}:{write:true,expires:Date.now()+60000})))
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true)
 const fileId=crypto.randomUUID(),baseRevision=crypto.randomUUID(),id=crypto.randomUUID()
 let release!:()=>void
 const writing=new Promise<void>(resolve=>{release=resolve})
 let revision=baseRevision
 const unbind=bindDocumentHandoff(transport,async(_topic,options)=>{
   if(outcome==='resetWhileWriting'){await writing;return undefined}
   if(outcome==='failed')return undefined
   options.onTool('insert_text','done',true)
   return {text:'Saved',cancelled:false,turnLimit:false}
 })
 const dispose=handoff.mountDocumentHandoff({fileId,format:'pdf',assistant:()=>({available:true,transport}),
   activate:()=>{},ready:()=>true,clean:()=>true,revision:()=>revision,save:async()=>{revision=crypto.randomUUID();return true}})
 const firstReview='First review'+'.'.repeat(4000)
 const send=async(review?:string)=>{
   const receipts=peer.postMessage.mock.calls.length
   window.dispatchEvent(new MessageEvent('message',{source:peer as unknown as Window,origin:'http://localhost',data:{
     type:'dsh-dyoffice:draft-request',fileId,ticket:'1234567890123.'+'a'.repeat(43),
     writing:{id,baseRevision,topic:'Edit PDF',...(review&&{review:{state:'ready',text:review}})},
   }}))
   await vi.waitFor(()=>expect(peer.postMessage.mock.calls.length).toBeGreaterThan(receipts))
 }
 const host=document.createElement('div'),root=createRoot(host)
 try{
   await act(async()=>root.render(h(handoff.DocumentHandoffMessages,{fileId})))
   await act(async()=>send())
   if(outcome==='resetWhileWriting'){
     await act(async()=>{handoff.resetDocumentHandoffMessages(fileId);release()})
     await act(async()=>send())
     expect(peer.postMessage.mock.lastCall?.[0].writing.state).toBe('conflict')
     expect(host.textContent).toBe('')
     return
   }
   await act(async()=>send(firstReview))
   expect(host.textContent).toContain(outcome==='saved'?'First review':'未确认完成写入。')
   await act(async()=>handoff.resetDocumentHandoffMessages('another-file'))
   expect(handoff.hasDocumentHandoffMessages(fileId)).toBe(true)
   const events:boolean[]=[]
   const off=handoff.subscribeDocumentHandoff(()=>events.push(handoff.hasDocumentHandoffMessages(fileId)))
   try{
     await act(async()=>handoff.resetDocumentHandoffMessages(fileId))
     expect(events.at(-1)).toBe(false)
     await act(async()=>send(firstReview))
     expect(host.textContent).toBe('')
     await act(async()=>send('Second review'))
     expect(host.textContent).toBe(outcome==='saved'?'DSHSecond review':'')
     expect(events.at(-1)).toBe(outcome==='saved')
     expect(peer.postMessage.mock.lastCall?.[0].writing.state).toBe(outcome==='saved'?'saved':'conflict')
   }finally{off()}
 }finally{await act(async()=>{root.unmount();dispose()});unbind?.();vi.unstubAllGlobals()}
})
