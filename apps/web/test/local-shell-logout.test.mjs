import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {runInNewContext} from 'node:vm'
import {transform} from 'esbuild'
const source=await readFile(new URL('../src/shell/local-main.tsx',import.meta.url),'utf8')
const {code}=await transform(source.slice(source.indexOf('let logoutPending='),source.indexOf('function WorkspacePageContent')),{loader:'ts',target:'es2022'})
function fixture({cancel=false,failDispose=false,failLogout=false}={}){
 const closed=[],events=[],activated=[]
 const frames=['a','b'].map(id=>({dataset:{documentId:id},contentWindow:{dyofficeEditorCanClose:async()=>{events.push('check:'+id);return !(id==='b'&&cancel)},dyofficeEditorDispose:async()=>{events.push('dispose:'+id);return !(id==='b'&&failDispose)}}}))
 const logout=runInNewContext(code+'\nlogout',{document:{querySelectorAll:()=>frames,getElementById:()=>null},documentTabs:{suspendEntries:()=>()=>{},activate:id=>{activated.push(id);events.push('activate:'+id)},close:async id=>closed.push(id)},entryRecovery:{clear:()=>events.push('clear-recovery')},client:{logout:async()=>{events.push('logout');if(failLogout)throw Error('network')}},location:{replace:()=>events.push('redirect')}})
 return {logout,closed,events,activated}
}
test('cancelled later editor leaves every editor intact and does not invalidate the session',async()=>{const f=fixture({cancel:true});await f.logout();assert.deepEqual(f.closed,[]);assert.deepEqual(f.events,['check:a','check:b'])})
test('later lease release failure removes already disposed tabs and preserves the failing editor',async()=>{const f=fixture({failDispose:true});await f.logout();assert.deepEqual(f.closed,['a']);assert.ok(!f.events.includes('logout'))})
test('logout network failure cannot leave disposed editors as empty tabs',async()=>{const f=fixture({failLogout:true});await assert.rejects(f.logout(),/network/);assert.deepEqual(f.closed,['a','b']);assert.ok(!f.events.includes('redirect'))})

test('successful logout activates Home before disposal and clears recovery only after logout succeeds',async()=>{const f=fixture();await f.logout();assert.deepEqual(f.closed,['a','b']);assert.deepEqual(f.activated,['home']);assert.deepEqual(f.events,['check:a','check:b','activate:home','dispose:a','dispose:b','logout','clear-recovery','redirect'])})

const {createDocumentTabs}=await import('../src/shell/document-tabs.ts')
const {createEditorCloseLifecycle}=await import('../src/editors/editor-close-lifecycle.ts')
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}}
function liveFixture(){
 const tabs=createDocumentTabs(),frames=[],events=[],app={inert:false},saveGate=deferred(),releaseGate=deferred(),entered=deferred()
 let dirty=true,allow=true,holdRelease=false,failLogout=false
 tabs.open({id:'a',format:'docx',name:'A',src:'/native-docs'})
 const lifecycle=createEditorCloseLifecycle({state:()=>({dirty,blocked:false}),confirm:()=>allow,notify:()=>{},save:async()=>{events.push('save');entered.resolve();await saveGate.promise;dirty=false;return true},release:async()=>{events.push('release');if(holdRelease)await releaseGate.promise},cleanup:()=>events.push('cleanup')})
 frames.push({dataset:{documentId:'a'},contentWindow:{dyofficeEditorCanClose:lifecycle.canClose,dyofficeEditorDispose:lifecycle.dispose}})
 tabs.setGuard('a',async()=>await lifecycle.canClose()&&await lifecycle.dispose())
 const logout=runInNewContext(code+'\nlogout',{document:{querySelectorAll:()=>frames,getElementById:()=>app},documentTabs:tabs,client:{logout:async()=>{events.push('logout');if(failLogout)throw Error('network')}},entryRecovery:undefined,location:{replace:()=>events.push('redirect')}})
 return {tabs,logout,events,app,entered,saveGate,releaseGate,setDirty:v=>dirty=v,isDirty:()=>dirty,setAllow:v=>allow=v,setHoldRelease:v=>holdRelease=v,setFailLogout:v=>failLogout=v}
}
const newDocument={id:'b',format:'xlsx',name:'B',src:'/native-sheets'}
test('logout fences in-flight open and new creation admission while a real editor saves',async()=>{
 const f=liveFixture(),token=f.tabs.reserveOpen('b'),pending=f.logout();await f.entered.promise
 assert.equal(f.app.inert,true)
 assert.throws(()=>f.tabs.open(newDocument,token),/退出/)
 assert.throws(()=>f.tabs.reserveOpen('b'),/退出/)
 assert.throws(()=>f.tabs.open(newDocument),/退出/)
 f.saveGate.resolve();await pending
 assert.deepEqual(f.events,['save','release','cleanup','logout','redirect'])
 assert.equal(f.app.inert,true)
 assert.throws(()=>f.tabs.open(newDocument),/退出/)
})
test('cancelled logout restores admission and UI without discarding the dirty editor',async()=>{
 const f=liveFixture();f.setAllow(false);await f.logout();assert.equal(f.app.inert,false);assert.equal(f.isDirty(),true);assert.deepEqual(f.events,[])
 f.tabs.open(newDocument);assert.equal(f.tabs.documents().length,2)
})
test('existing editor changed during release aborts logout and preserves draft and admission',async()=>{
 const f=liveFixture();f.setHoldRelease(true);const pending=f.logout();await f.entered.promise;f.saveGate.resolve()
 while(!f.events.includes('release'))await new Promise(r=>setImmediate(r))
 f.setDirty(true);f.releaseGate.resolve();await pending
 assert.equal(f.app.inert,false);assert.equal(f.isDirty(),true);assert.deepEqual(f.events,['save','release']);assert.equal(f.tabs.documents()[0].id,'a');f.tabs.open(newDocument)
})
test('concurrent logout clicks cannot double-dispose or invalidate the session twice',async()=>{
 const f=liveFixture(),first=f.logout();await f.entered.promise;const second=f.logout();f.saveGate.resolve();await Promise.all([first,second]);assert.equal(f.events.filter(e=>e==='logout').length,1);assert.equal(f.events.filter(e=>e==='cleanup').length,1)
})
test('failed logout restores admission after closing only confirmed-clean editors',async()=>{
 const f=liveFixture();f.setFailLogout(true);const pending=f.logout();await f.entered.promise;f.saveGate.resolve();await assert.rejects(pending,/network/);assert.equal(f.app.inert,false);assert.deepEqual(f.tabs.documents(),[]);f.tabs.open(newDocument)
})

test('actual XLSX created-document completion cannot mount after logout starts',async()=>{
 const {openCreatedDocument}=await import('../src/shell/local-new-sheet.ts')
 const f=liveFixture(),read=deferred(),started=deferred(),requests=[]
 const opening=openCreatedDocument(f.tabs,{xlsx:'editable'},'b',async(path,method)=>{requests.push([path,method]);if(!method){started.resolve();await read.promise;return {name:'B.xlsx',format:'xlsx',file:{fileId:'b',revision:'r1'},downloadEndpoint:'/api/v1/files/b/content?revision=r1'}}})
 await started.promise;const closing=f.logout();await f.entered.promise;read.resolve()
 await assert.rejects(opening,/退出/);assert.deepEqual(f.tabs.documents().map(d=>d.id),['a']);assert.equal(requests.length,2)
 f.saveGate.resolve();await closing
})
test('admission suspension cannot activate a dormant restored editor, and release is idempotent',()=>{
 const tabs=createDocumentTabs();tabs.restoreEntries([{id:'a',format:'docx',name:'A',src:'/native-docx'},newDocument],'a')
 const resume=tabs.suspendEntries();assert.throws(()=>tabs.activate('b'),/退出/);assert.deepEqual(tabs.renderedDocuments().map(d=>d.id),['a'])
 resume();resume();tabs.activate('b');assert.deepEqual(tabs.renderedDocuments().map(d=>d.id),['a','b'])
})
test('a close already awaiting its guard cannot mount a dormant neighbor during logout',async()=>{
 const tabs=createDocumentTabs();tabs.restoreEntries([{id:'a',format:'docx',name:'A',src:'/native-docx'},newDocument],'a')
 const gate=deferred(),entered=deferred();tabs.setGuard('a',async()=>{entered.resolve();await gate.promise;return true})
 const closing=tabs.close('a');await entered.promise
 const resume=tabs.suspendEntries();gate.resolve();assert.equal(await closing,true)
 assert.deepEqual(tabs.renderedDocuments(),[]);assert.equal(tabs.list().find(t=>t.active).id,'home');assert.equal(tabs.documents()[0].id,'b')
 resume();tabs.activate('b');assert.equal(tabs.renderedDocuments()[0].id,'b')
})
