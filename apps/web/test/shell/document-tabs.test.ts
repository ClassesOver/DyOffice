import {expect,test,vi} from 'vitest'
import {createDocumentTabs,tabCloseTargets,tabMoveIndex} from '../../src/shell/document-tabs'
const a={id:'file-a',format:'docx' as const,name:'合同.docx',src:'/native-docx/?fileId=file-a'}
const b={id:'file-b',format:'xlsx' as const,name:'预算.xlsx',src:'/native-xlsx/?fileId=file-b'}
const c={id:'file-c',format:'pdf' as const,name:'说明.pdf',src:'/native-pdf/?fileId=file-c'}
const d={id:'file-d',format:'pptx' as const,name:'汇报.pptx',src:'/native-pptx/?fileId=file-d'}

test('idle sleep preserves the tab and skips dirty, pinned and visible editors',async()=>{
 let clock=0
 const tabs=createDocumentTabs({now:()=>clock})
 for(const file of [a,b,c,d])tabs.open(file)
 const dirty=vi.fn(()=>false),clean=vi.fn(()=>true),pinned=vi.fn(()=>true),visible=vi.fn(()=>true)
 tabs.setSleepGuard(a.id,dirty);tabs.setSleepGuard(b.id,clean)
 tabs.setSleepGuard(c.id,pinned);tabs.setSleepGuard(d.id,visible)
 tabs.setPinned(c.id,true)
 expect(await tabs.sleepIdleTabs({maxLiveTabs:1,idleMs:10})).toEqual([])
 clock=20
 expect(await tabs.sleepIdleTabs({maxLiveTabs:1,idleMs:10})).toEqual([b.id])
 expect(tabs.list().find(tab=>tab.id===b.id)?.dormant).toBe(true)
 expect(tabs.documents()).toEqual([a,b,c,d])
 expect(tabs.renderedDocuments()).toEqual([a,c,d])
 expect(pinned).not.toHaveBeenCalled()
 expect(visible).not.toHaveBeenCalled()
 tabs.activate(b.id)
 expect(tabs.list().find(tab=>tab.id===b.id)).toMatchObject({active:true})
 expect(tabs.list().find(tab=>tab.id===b.id)?.dormant).toBeUndefined()
 expect(tabs.renderedDocuments()).toEqual([a,b,c,d])
})

test('selecting a split pane during disposal remounts it after release',async()=>{
 let clock=0
 const tabs=createDocumentTabs({now:()=>clock})
 tabs.open(a);tabs.open(b)
 let release!:(ok:boolean)=>void
 tabs.setSleepGuard(a.id,()=>new Promise<boolean>(resolve=>{release=resolve}))
 const oldGeneration=tabs.renderGeneration(a.id)
 clock=20
 const sweep=tabs.sleepIdleTabs({maxLiveTabs:1,idleMs:10})
 await Promise.resolve()
 tabs.splitBeside(a.id)
 release(true)
 await sweep
 expect(tabs.splitView()).toEqual({left:b.id,right:a.id})
 expect(tabs.renderedDocuments()).toEqual([a,b])
 expect(tabs.renderGeneration(a.id)).not.toBe(oldGeneration)
})

test('split view loads a second pane and follows selection or closing without unloading drafts',async()=>{
 const tabs=createDocumentTabs()
 tabs.restoreEntries([a,b,c],a.id)
 tabs.splitBeside(b.id)
 expect(tabs.splitView()).toEqual({left:a.id,right:b.id})
 expect(tabs.renderedDocuments()).toEqual([a,b])
 expect(tabs.list().find(tab=>tab.active)?.id).toBe(a.id)
 tabs.activate(b.id)
 expect(tabs.splitView()).toEqual({left:a.id,right:b.id})
 tabs.activate(c.id)
 expect(tabs.splitView()).toBeNull()
 expect(tabs.renderedDocuments()).toEqual([a,b,c])
 tabs.activate('home')
 tabs.splitBeside(a.id)
 expect(tabs.splitView()).toEqual({left:'home',right:a.id})
 tabs.setGuard(a.id,()=>true)
 await tabs.close(a.id)
 expect(tabs.splitView()).toBeNull()
})

test('a tab relocation can be cancelled after the close prompt without removing the source',async()=>{
 const tabs=createDocumentTabs()
 tabs.open(a)
 let permitted=true
 const dispose=vi.fn()
 tabs.setGuard(a.id,async canDispose=>{
  await Promise.resolve()
  permitted=false
  if(canDispose&&!canDispose())return false
  dispose()
  return true
 })
 expect(await tabs.close(a.id,{canDispose:()=>permitted,remember:false})).toBe(false)
 expect(tabs.documents()).toEqual([a])
 expect(dispose).not.toHaveBeenCalled()
 tabs.setGuard(a.id,()=>true)
 expect(await tabs.close(a.id,{remember:false})).toBe(true)
 expect(tabs.canReopenClosed()).toBe(false)
})

test('pinning restores and loads the background editor without reordering or selecting it',async()=>{
 const tabs=createDocumentTabs()
 tabs.restoreEntries([a,b,c],a.id,[b.id,'missing'])
 expect(tabs.list().map(({id,pinned})=>[id,!!pinned])).toEqual([
  ['home',false],[a.id,false],[b.id,true],[c.id,false],
 ])
 expect(tabs.renderedDocuments()).toEqual([a,b])
 tabs.setPinned(c.id,true)
 tabs.setPinned(b.id,false)
 expect(tabs.list().find(tab=>tab.active)?.id).toBe(a.id)
 expect(tabCloseTargets(tabs.list(),a.id,'closeRight')).toEqual([b.id,c.id])
 tabs.setGuard(c.id,()=>true)
 expect(await tabs.close(c.id)).toBe(true)
 await tabs.reopenClosed(async()=>c)
 expect(tabs.list().find(tab=>tab.id===c.id)?.pinned).toBeUndefined()
})

test('relative moves stay between document tabs and leave selection and mounted editors alone',()=>{
 const tabs=createDocumentTabs()
 tabs.restoreEntries([a,b,c],a.id)
 expect(tabMoveIndex(tabs.list(),'home',1)).toBeUndefined()
 expect(tabMoveIndex(tabs.list(),a.id,-1)).toBeUndefined()
 expect(tabMoveIndex(tabs.list(),c.id,1)).toBeUndefined()
 expect(tabMoveIndex(tabs.list(),'missing',-1)).toBeUndefined()
 tabs.reorder(c.id,tabMoveIndex(tabs.list(),c.id,-1)!)
 tabs.reorder(a.id,tabMoveIndex(tabs.list(),a.id,1)!)
 expect(tabs.list().map(tab=>tab.id)).toEqual(['home',c.id,a.id,b.id])
 expect(tabs.list().find(tab=>tab.active)?.id).toBe(a.id)
 expect(tabs.renderedDocuments()).toEqual([a])
})

test('reopen uses the most recently closed document still available and never adds a duplicate',async()=>{
 const tabs=createDocumentTabs()
 for(const file of [a,b,c]){
  tabs.open(file);tabs.setGuard(file.id,()=>true)
 }
 await tabs.closeMany([a.id,b.id,c.id])
 const resolve=vi.fn(async id=>{
  if(id===c.id)throw Object.assign(Error('trashed'),{status:404})
  return id===b.id?{...b,name:'Renamed.xlsx'}:a
 })
 expect(tabs.canReopenClosed()).toBe(true)
 await tabs.reopenClosed(resolve)
 expect(resolve.mock.calls.map(([id])=>id)).toEqual([c.id,b.id])
 expect(tabs.documents()).toEqual([{...b,name:'Renamed.xlsx'}])
 tabs.open(a)
 expect(tabs.canReopenClosed()).toBe(false)
})

test('cancelled and citation closes stay out of reopen history, while transient failures keep the entry',async()=>{
 const tabs=createDocumentTabs()
 tabs.open({...a,sourceRevision:'r1'});tabs.setGuard(a.id,()=>true)
 await tabs.close(a.id)
 tabs.open(b);tabs.setGuard(b.id,()=>false)
 await tabs.close(b.id)
 expect(tabs.canReopenClosed()).toBe(false)
 tabs.setGuard(b.id,()=>true);await tabs.close(b.id)
 await expect(tabs.reopenClosed(async()=>{throw Object.assign(Error('busy'),{status:503})})).rejects.toThrow('busy')
 expect(tabs.canReopenClosed()).toBe(true)
 await tabs.reopenClosed(async()=>b)
 expect(tabs.list().find(tab=>tab.active)?.id).toBe(b.id)
})

test('an in-flight reopen respects a newer tab selection and retains its history entry',async()=>{
 const tabs=createDocumentTabs()
 tabs.open(a);tabs.setGuard(a.id,()=>true);await tabs.close(a.id)
 let finish!:(file:typeof a)=>void
 const resolve=vi.fn(()=>new Promise<typeof a>(done=>{finish=done}))
 const reopening=tabs.reopenClosed(resolve)
 await Promise.resolve()
 tabs.open(b);finish(a)
 await reopening
 expect(tabs.documents()).toEqual([b])
 expect(tabs.canReopenClosed()).toBe(true)
})

test('bulk close targets follow tab order and exclude Home',()=>{
 const tabs=createDocumentTabs()
 tabs.restoreEntries([a,b,c,d],a.id)
 tabs.reorder(d.id,2)
 expect(tabCloseTargets(tabs.list(),d.id,'closeRight')).toEqual([b.id,c.id])
 expect(tabCloseTargets(tabs.list(),d.id,'closeOthers')).toEqual([a.id,b.id,c.id])
 expect(tabCloseTargets(tabs.list(),d.id,'closeAll')).toEqual([a.id,d.id,b.id,c.id])
 expect(tabCloseTargets(tabs.list(),'missing','closeRight')).toEqual([])
})

test('batch close stops at the first refused editor and leaves later tabs untouched',async()=>{
 const tabs=createDocumentTabs()
 tabs.open(a);tabs.open(b);tabs.open(c)
 const closeOrder:string[]=[]
 tabs.setGuard(a.id,()=>{closeOrder.push(a.id);return true})
 tabs.setGuard(b.id,()=>{closeOrder.push(b.id);return false})
 tabs.setGuard(c.id,()=>{closeOrder.push(c.id);return true})
 await tabs.closeMany([a.id,b.id,c.id])
 expect(closeOrder).toEqual([a.id,b.id])
 expect(tabs.list().map(tab=>tab.id)).toEqual(['home',b.id,c.id])
})

test('closing all skips missing tabs and never mounts dormant editors',async()=>{
 const tabs=createDocumentTabs()
 tabs.restoreEntries([a,b,c],a.id)
 const renders:string[][]=[]
 tabs.subscribe(()=>renders.push(tabs.renderedDocuments().map(tab=>tab.id)))
 tabs.setGuard(a.id,async()=>true)
 await tabs.closeMany(['home','missing',a.id,b.id,c.id])
 expect(renders.flat()).toEqual([])
 expect(tabs.list()).toEqual([{id:'home',kind:'home',title:'首页',closable:false,active:true}])
})

test('a citation only reuses a mounted editor if it proves that it displays the cited saved revision',()=>{
 let displayed:string|undefined
 const tabs=createDocumentTabs({displayedRevision:()=>displayed})
 const citation={...a,src:`${a.src}&sourceRevision=r1`,sourceRevision:'r1'}
 tabs.open(a);tabs.open(b)
 expect(()=>tabs.open(citation)).toThrow('cited revision')
 expect(tabs.list().find(t=>t.active)?.id).toBe(b.id)
 displayed='r1';tabs.open(citation)
 expect(tabs.renderedDocuments().find(file=>file.id===a.id)?.src).toBe(a.src)
 expect(tabs.list().find(t=>t.active)?.id).toBe(a.id)
})

test('ordinary opens recover an expired citation without replacing live drafts',()=>{
 let expired=false
 const tabs=createDocumentTabs({isCitationExpired:()=>expired})
 const citation={...b,src:`${b.src}&sourceRevision=r1`,sourceRevision:'r1'}
 tabs.open(citation);tabs.open(b)
 expect(tabs.documents()).toEqual([citation])
 expired=true;tabs.open(b)
 expect(tabs.documents()).toEqual([b])
})

test('a citation superseded by a later navigation leaves no dormant tab',()=>{
 const tabs=createDocumentTabs()
 const token=tabs.reserveOpen(b.id)
 tabs.open(a)
 tabs.open({...b,src:b.src+'&sourceRevision=r1',sourceRevision:'r1'},token)
 expect(tabs.documents()).toEqual([a])
})

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
 expect(tabs.list()[0].active).toBe(true)
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

test.each(['docx','pdf'] as const)('a delayed %s open cannot resurrect a successfully closed tab',async format=>{
 const tabs=createDocumentTabs(),document={...a,format,src:format==='docx'?a.src:'/api/v1/files/file-a/content?revision=r1'}
 tabs.open(document);tabs.setGuard(a.id,()=>true)
 const delayed=tabs.reserveOpen(a.id)
 expect(await tabs.close(a.id)).toBe(true)
 tabs.open(document,delayed)
 expect(tabs.documents()).toEqual([])
 expect(tabs.list().find(tab=>tab.active)?.id).toBe('home')
 const fresh=tabs.reserveOpen(a.id);tabs.open({...document,name:'Fresh open'},fresh)
 tabs.open({...document,name:'Old response'},delayed)
 expect(tabs.documents()).toEqual([{...document,name:'Fresh open'}])
})

test('a cancelled close keeps pending opens valid',async()=>{
 const tabs=createDocumentTabs();tabs.open(a);tabs.setGuard(a.id,()=>false)
 const pending=tabs.reserveOpen(a.id)
 expect(await tabs.close(a.id)).toBe(false)
 tabs.open({...a,name:'Updated name'},pending)
 expect(tabs.documents()[0].name).toBe('Updated name')
})

test('a slower open creates a background tab without overriding the later selected document',()=>{
 const tabs=createDocumentTabs(),old=tabs.reserveOpen(a.id),latest=tabs.reserveOpen(b.id)
 tabs.open(b,latest);tabs.open(a,old)
 expect(tabs.list().find(tab=>tab.active)?.id).toBe(b.id)
 expect(tabs.documents()).toHaveLength(2)
})
test('explicitly selecting Home while an open is pending keeps Home selected',()=>{
 const tabs=createDocumentTabs(),pending=tabs.reserveOpen(a.id)
 tabs.activate('home');tabs.open(a,pending)
 expect(tabs.list().find(tab=>tab.active)?.id).toBe('home')
 expect(tabs.documents()).toEqual([a])
})
test('closing the selected tab keeps its neighbor selected when another pending open finishes',async()=>{
 const tabs=createDocumentTabs();tabs.open(a);tabs.open(b);tabs.setGuard(b.id,()=>true)
 const pending=tabs.reserveOpen('c')
 expect(await tabs.close(b.id)).toBe(true)
 tabs.open({id:'c',format:'pdf',name:'c.pdf',src:'/pdf/c'},pending)
 expect(tabs.list().find(tab=>tab.active)?.id).toBe(a.id)
})

test('closing a background tab preserves the latest pending open selection',async()=>{
 const tabs=createDocumentTabs();tabs.open(a);tabs.open(b);tabs.setGuard(a.id,()=>true)
 const pending=tabs.reserveOpen('c')
 expect(await tabs.close(a.id)).toBe(true)
 tabs.open({id:'c',format:'pdf',name:'c.pdf',src:'/pdf/c'},pending)
 expect(tabs.list().find(tab=>tab.active)?.id).toBe('c')
})
test('requests reserved during a confirmed close stay cancelled but a later explicit open works',async()=>{
 const tabs=createDocumentTabs();tabs.open(a)
 let allow!:(value:boolean)=>void
 tabs.setGuard(a.id,()=>new Promise<boolean>(resolve=>{allow=resolve}))
 const closing=tabs.close(a.id);await Promise.resolve()
 const pending=tabs.reserveOpen(a.id)
 allow(true);expect(await closing).toBe(true)
 tabs.open(a,pending);expect(tabs.documents()).toHaveLength(0)
 tabs.open(a,tabs.reserveOpen(a.id));expect(tabs.documents()).toEqual([a])
})

test('restored entries mount only selected document and dormant close does not need an editor guard',async()=>{
 const tabs=createDocumentTabs()
 tabs.restoreEntries([a,b],b.id)
 expect(tabs.list().map(t=>t.id)).toEqual(['home',a.id,b.id])
 expect(tabs.renderedDocuments()).toEqual([b])
 expect(await tabs.close(a.id)).toBe(true)
 expect(await tabs.close(b.id)).toBe(false)
})
test('activating a restored entry retains already mounted editors and does not reset existing close guards',async()=>{
 const tabs=createDocumentTabs();tabs.restoreEntries([a,b],a.id)
 tabs.setGuard(a.id,()=>false);tabs.activate(b.id)
 expect(tabs.renderedDocuments()).toEqual([a,b]);expect(await tabs.close(a.id)).toBe(false)
 expect(()=>tabs.restoreEntries([b],'home')).toThrow()
})

test('workspace restore mounts both split panes while keeping unrelated tabs dormant',()=>{
 const tabs=createDocumentTabs()
 const layout={left:a.id,right:b.id,width:65}
 tabs.restoreEntries([a,b,c],b.id,[],layout)
 expect(tabs.splitView()).toEqual(layout)
 expect(tabs.renderedDocuments().map(file=>file.id)).toEqual([a.id,b.id])
 tabs.resizeSplit(80)
 expect(tabs.splitView()).toEqual(layout)
 tabs.resizeSplit(55)
 expect(tabs.splitView()?.width).toBe(55)
 tabs.activate(c.id)
 expect(tabs.splitView()).toBeNull()
})

test('swapping the two panes preserves the active tab, divider and mounted documents',()=>{
 const tabs=createDocumentTabs()
 tabs.restoreEntries([a,b],a.id)
 tabs.splitBeside(b.id)
 tabs.resizeSplit(65)
 tabs.swapSplit()
 expect(tabs.splitView()).toEqual({left:b.id,right:a.id,width:65})
 expect(tabs.list().find(tab=>tab.active)?.id).toBe(a.id)
 expect(tabs.renderedDocuments()).toEqual([a,b])
 tabs.endSplit()
 tabs.swapSplit()
 expect(tabs.splitView()).toBeNull()

 const fresh=createDocumentTabs()
 fresh.restoreEntries([a,b],a.id,[],{left:a.id,right:'home',width:55})
 expect(fresh.splitView()).toEqual({left:a.id,right:'home',width:55})
 expect(fresh.renderedDocuments()).toEqual([a])
})
