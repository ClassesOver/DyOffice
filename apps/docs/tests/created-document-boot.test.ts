import {expect,it,vi} from 'vitest'
import {completeCreatedDocumentBoot} from '../src/renderer/ai/created-document-boot'

it('Web applies queued AI body after opening its uploaded DOCX and confirms after save',async()=>{
 const events:string[]=[]
 let finish!:(value:boolean)=>void
 const save=new Promise<boolean>(resolve=>{finish=resolve})
 const context={doc:{filePath:'/files/new/blank.docx'}}
 const done=completeCreatedDocumentBoot({content:{title:'Report',html:'<p>Body</p>'},pendingPath:'/files/new/blank.docx',opened:true,hosted:true,getContext:()=>context as never,apply:async()=>{events.push('insert');return save},complete:accepted=>events.push(accepted?'saved':'failed')})
 await Promise.resolve();expect(events).toEqual(['insert'])
 finish(true);await done;expect(events).toEqual(['insert','saved'])
})
it.each([false,true])('failed Web opening or body save never acknowledges creation (%s)',async opened=>{
 const apply=vi.fn(async()=>false),complete=vi.fn()
 await completeCreatedDocumentBoot({content:{title:'Report',html:'<p>Body</p>'},pendingPath:'new',opened,hosted:true,getContext:()=>({doc:{filePath:'new'}}) as never,apply,complete})
 expect(complete).toHaveBeenCalledExactlyOnceWith(false)
 expect(apply).toHaveBeenCalledTimes(opened?1:0)
})
it('desktop opening an existing DOCX does not replace its body with a queued creation',async()=>{
 const apply=vi.fn(),complete=vi.fn()
 await completeCreatedDocumentBoot({content:{title:'Report',html:'<p>Body</p>'},pendingPath:'existing',opened:true,hosted:false,getContext:()=>({doc:{filePath:'existing'}}) as never,apply,complete})
 expect(apply).not.toHaveBeenCalled();expect(complete).not.toHaveBeenCalled()
})
it('body insertion errors notify the initiating tool rather than disappearing in boot handling',async()=>{
 const complete=vi.fn()
 await expect(completeCreatedDocumentBoot({content:{title:'Report',html:'<p>Body</p>'},pendingPath:'new',opened:true,hosted:true,getContext:()=>({doc:{filePath:'new'}}) as never,apply:async()=>{throw Error('serialize failed')},complete})).rejects.toThrow('serialize failed')
 expect(complete).toHaveBeenCalledExactlyOnceWith(false)
})
