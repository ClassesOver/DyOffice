import {expect,test,vi} from 'vitest'
import {createDocumentTabs} from '../../src/shell/document-tabs'
const a={id:'file-a',format:'docx' as const,name:'合同.docx',src:'/native-docx/?fileId=file-a'}
const b={id:'file-b',format:'xlsx' as const,name:'预算.xlsx',src:'/native-xlsx/?fileId=file-b'}

test('home is permanent and opening a file deduplicates and activates its original document',async()=>{
 const tabs=createDocumentTabs(),changed=vi.fn(),stop=tabs.subscribe(changed)
 expect(tabs.list()).toEqual([{id:'home',kind:'home',title:'首页',closable:false,active:true}])
 tabs.open(a);tabs.open(b);tabs.open({...a,src:'/must-not-reload'})
 expect(tabs.list().map(t=>[t.id,t.kind,t.active])).toEqual([['home','home',false],['file-a','docs',true],['file-b','sheets',false]])
 expect(tabs.documents()).toEqual([a,b])
 expect(await tabs.close('home')).toBe(false)
 tabs.reorder('home',2);expect(tabs.list()[0].id).toBe('home')
 stop();const calls=changed.mock.calls.length;tabs.activate('home');expect(changed).toHaveBeenCalledTimes(calls)
})

test('all supported document formats map to the shared tab kinds and snapshots cannot mutate state',()=>{
 const tabs=createDocumentTabs();tabs.open(a);tabs.open(b)
 tabs.open({id:'c',format:'pptx',name:'汇报.pptx',src:'/slides/c'});tabs.open({id:'d',format:'pdf',name:'扫描.pdf',src:'/pdf/d'})
 expect(tabs.list().map(t=>t.kind)).toEqual(['home','docs','sheets','slides','pdf'])
 tabs.list()[0].title='changed';tabs.documents()[0].src='changed'
 expect(tabs.list()[0].title).toBe('首页');expect(tabs.documents()[0].src).toBe(a.src)
 tabs.activate('missing');expect(tabs.list().find(t=>t.active)?.id).toBe('d')
})

test('async close awaits one guard, cancellation retains the document, and a confirmed close selects its neighbor',async()=>{
 const tabs=createDocumentTabs();tabs.open(a);tabs.open(b)
 let finish!:(allowed:boolean)=>void
 const guard=vi.fn(()=>new Promise<boolean>(resolve=>{finish=resolve}));tabs.setGuard(b.id,guard)
 const first=tabs.close(b.id),duplicate=tabs.close(b.id)
 await Promise.resolve();expect(guard).toHaveBeenCalledOnce();expect(tabs.documents()).toHaveLength(2)
 finish(false);expect(await first).toBe(false);expect(await duplicate).toBe(false)
 expect(tabs.list().find(t=>t.active)?.id).toBe(b.id)
 tabs.setGuard(b.id,async()=>true);expect(await tabs.close(b.id)).toBe(true)
 tabs.setGuard(a.id,()=>true)
 expect(tabs.list().find(t=>t.active)?.id).toBe(a.id)
 expect(await tabs.close(a.id)).toBe(true);expect(tabs.list().find(t=>t.active)?.id).toBe('home')
})

test('close failure keeps the document and closing a background tab preserves the active one',async()=>{
 const tabs=createDocumentTabs();tabs.open(a);tabs.open(b)
 tabs.setGuard(a.id,async()=>{throw Error('save failed')})
 await expect(tabs.close(a.id)).rejects.toThrow('save failed');expect(tabs.documents()).toHaveLength(2)
 tabs.setGuard(a.id,()=>true);expect(await tabs.close(a.id)).toBe(true)
 expect(tabs.list().find(t=>t.active)?.id).toBe(b.id)
 expect(await tabs.close('missing')).toBe(false)
})

test('reordering clamps documents after home and closing uses the new adjacent tab',async()=>{
 const tabs=createDocumentTabs();tabs.open(a);tabs.open(b);tabs.open({id:'c',format:'pdf',name:'c.pdf',src:'/pdf/c'})
 tabs.reorder('c',0);expect(tabs.list().map(t=>t.id)).toEqual(['home','c',a.id,b.id])
 await tabs.close('c');expect(tabs.list().find(t=>t.active)?.id).toBe(a.id)
 tabs.reorder(a.id,100);expect(tabs.list().map(t=>t.id)).toEqual(['home',b.id,a.id])
 tabs.reorder(a.id,NaN);expect(tabs.list().map(t=>t.id)).toEqual(['home',b.id,a.id])
})

test('native document tabs refuse closing before their editor close guard is registered',async()=>{
 const tabs=createDocumentTabs();tabs.open(a);tabs.open(b)
 expect(await tabs.close(a.id)).toBe(false);expect(await tabs.close(b.id)).toBe(false)
 expect(tabs.documents()).toHaveLength(2)
 tabs.setGuard(a.id,()=>true);expect(await tabs.close(a.id)).toBe(true)
 tabs.setGuard(b.id,()=>true);tabs.setGuard(b.id,null)
 expect(await tabs.close(b.id)).toBe(false)
})

test('read-only previews can close without an editor lifecycle guard regardless of file format',async()=>{
 const tabs=createDocumentTabs();tabs.open({...b,src:'/api/v1/files/file-b/content?revision=r1'})
 expect(await tabs.close(b.id)).toBe(true)
})

test('rename refreshes a background title once while preserving its active editor and close guard',async()=>{
 const tabs=createDocumentTabs(),changed=vi.fn(),guard=vi.fn(()=>false)
 tabs.open(a);tabs.setGuard(a.id,guard);tabs.activate('home');tabs.subscribe(changed)
 tabs.rename(a.id,'新合同.docx')
 expect(tabs.list()[1].title).toBe('新合同.docx')
 expect(tabs.documents()[0]).toEqual({...a,name:'新合同.docx'})
 expect(tabs.list()[0].active).toBe(true)
 expect(changed).toHaveBeenCalledTimes(1)
 tabs.rename(a.id,'新合同.docx');tabs.rename('missing','ignored');tabs.rename('home','ignored')
 expect(changed).toHaveBeenCalledTimes(1)
 expect(await tabs.close(a.id)).toBe(false);expect(guard).toHaveBeenCalledOnce()
})

test('reopening refreshes the name in one notification without replacing source format or guard',async()=>{
 const tabs=createDocumentTabs(),changed=vi.fn(),guard=vi.fn(()=>false)
 tabs.open(a);tabs.setGuard(a.id,guard);tabs.activate('home');tabs.subscribe(changed)
 tabs.open({...a,name:'重命名.docx',src:'/must-not-reload',format:'pdf'})
 expect(tabs.documents()).toEqual([{...a,name:'重命名.docx'}])
 expect(tabs.list()[1]).toMatchObject({title:'重命名.docx',kind:'docs',active:true})
 expect(changed).toHaveBeenCalledTimes(1)
 tabs.open({...a,name:'重命名.docx',src:'/still-must-not-reload'})
 expect(changed).toHaveBeenCalledTimes(1)
 expect(await tabs.close(a.id)).toBe(false);expect(guard).toHaveBeenCalledOnce()
})

test('a late open cannot roll back a newer confirmed rename',()=>{
 const tabs=createDocumentTabs();tabs.open(a)
 const token=tabs.reserveOpen(a.id)
 tabs.rename(a.id,'confirmed.docx');tabs.activate('home')
 tabs.open(a,token)
 expect(tabs.documents()[0].name).toBe('confirmed.docx')
 expect(tabs.list()[1].active).toBe(true)
})

for(const order of ['old-first','new-first'])test(`concurrent opens retain the later request metadata when responses arrive ${order}`,()=>{
 const tabs=createDocumentTabs();tabs.open(a)
 const old=tabs.reserveOpen(a.id),fresh=tabs.reserveOpen(a.id)
 const oldResponse=()=>tabs.open({...a,name:'old.docx'},old)
 const newResponse=()=>tabs.open({...a,name:'new.docx'},fresh)
 if(order==='old-first'){oldResponse();newResponse()}else{newResponse();oldResponse()}
 expect(tabs.documents()[0].name).toBe('new.docx')
})

test('rename while the first open is pending supplies the confirmed name without activating a tab',()=>{
 const tabs=createDocumentTabs(),changed=vi.fn();tabs.subscribe(changed)
 const token=tabs.reserveOpen(a.id)
 tabs.rename(a.id,'confirmed before open.docx')
 expect(tabs.documents()).toEqual([]);expect(changed).not.toHaveBeenCalled()
 tabs.open(a,token)
 expect(tabs.documents()).toEqual([{...a,name:'confirmed before open.docx'}])
 expect(changed).toHaveBeenCalledOnce()
})
