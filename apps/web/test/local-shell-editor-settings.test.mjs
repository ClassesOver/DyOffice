import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {runInNewContext} from 'node:vm'
import {transform} from 'esbuild'
import {createDocumentTabs} from '../src/shell/document-tabs.ts'
import {createEntryNavigator} from '../src/shell/workspace-entry-navigation.ts'
import {createEntryRecovery,entryHash,parseEntryHash,resolveEntrySnapshot} from '../src/shell/workspace-entry-recovery.ts'
import {defaultMaxLiveTabs,DEFAULT_IDLE_MS,SLEEP_SWEEP_INTERVAL_MS} from '../../shell/src/main/tab-hibernation.ts'
import {localNewFormats} from '../src/shell/local-new-sheet.ts'
import {workspaceWorkbookImports} from '../src/shell/workspace-file-formats.ts'
const source=await readFile(new URL('../src/shell/local-main.tsx',import.meta.url),'utf8')
const {code}=await transform(source.slice(source.indexOf('function Shell('),source.indexOf('function Login(')),{loader:'tsx',target:'es2022',jsxFactory:'jsx'})
function fixture({roles=['personal','config_admin'],recovery=false,openInitial=true,initialHash,resolveOpenDocument=async()=>{throw Error('Unexpected document navigation')}}={}){
 const values=[],refs=[],effects=[],installed=[],listeners=new Set(),caller={location:{origin:'http://localhost'}};let stateIndex=0,refIndex=0,effectIndex=0
 const documentTabs=createDocumentTabs(),id='10000000-0000-0000-0000-000000000001'
 if(openInitial)documentTabs.open({id,format:'docx',name:'example.docx',src:`/native-docs/?id=${id}`})
 const location={hash:initialHash??entryHash(id),search:''}
 const events=new Map()
 const stage={location:{origin:'http://localhost'},setInterval:()=>1,clearInterval(){},addEventListener:(kind,fn)=>events.set(kind,fn),removeEventListener:kind=>events.delete(kind)}
 const context={
  jsx:(type,props,...children)=>({type,props:{...props,children}}),
  useState:initial=>{const i=stateIndex++;if(!(i in values))values[i]=typeof initial==='function'?initial():initial;return[values[i],value=>{values[i]=typeof value==='function'?value(values[i]):value}]},
  useRef:initial=>{const i=refIndex++;return refs[i]??(refs[i]={current:initial})},useCallback:fn=>fn,useMemo:fn=>fn(),
  useEffect:(fn,deps)=>{const i=effectIndex++,old=installed[i];if(!old||!deps||deps.some((value,index)=>!Object.is(value,old.deps[index])))effects.push(()=>{old?.cleanup?.();installed[i]={deps,cleanup:fn()}})},
  client:{onSessionEnded:fn=>{listeners.add(fn);return()=>listeners.delete(fn)}},documentTabs,entryRecoveryNotice:'',entryRecovery:undefined,sourceWorkspace:undefined,
  createEntryNavigator,entryHash,parseEntryHash,localNewFormats,workspaceWorkbookImports,resolveOpenDocument,
  URL,URLSearchParams,navigator:{deviceMemory:16},location,history:{replaceState(_data,_title,hash){location.hash=hash},pushState(_data,_title,hash){location.hash=hash}},window:stage,
  workspaceWindow:undefined,officeImportUnlocks:new Map(),takeOfficeImportUnlock(){},saveWorkspaceEntries(){},updateAutoFileTab(){},saveWorkspaceAssistantSide(){throw new Error('Unexpected preference save')},
  defaultMaxLiveTabs,DEFAULT_IDLE_MS,SLEEP_SWEEP_INTERVAL_MS,sleepInactiveTabs:false,canCheckpointWorkspace:false,restoreSession:false,logoutPending:false,
  document:{querySelectorAll:selector=>selector==='.workspace-document-frame'?[{contentWindow:caller}]:[]},
  user:{id:'me',roles},capabilities:{},showUpload(){},showChromeMenu(){},showTrash(){},notice(){},updateAutoPdfTab(){},
  AppFrame:'frame',Account:'account',DocumentFrame:'document-frame',NativeSettingsDialog:'dialog',WorkspacePageContent:'content',WorkspaceUploadDialog:'upload',Dropdown:'dropdown',workspacePages:{settings:'个人设置',global:'全局配置'},React:{Fragment:'fragment'},
 }
 const renderShell=runInNewContext(code+'\nShell',context)
 function render(){stateIndex=refIndex=effectIndex=0;effects.length=0;const tree=renderShell({recovery});for(const effect of effects)effect();return tree}
 render()
 const app=()=>render().props.children.find(node=>node?.type==='frame')
 const dialog=()=>render().props.children.find(node=>node?.type==='dialog');const content=()=>dialog()?.props.children[0]
 const activeFrame=()=>app().props.editorContent.props.children[0].find(node=>!node.props.hidden)
 return {stage,caller,values,dialog,content,app,activeFrame,render,location,emit:kind=>events.get(kind)?.(),endSession:()=>{for(const listener of listeners)listener()},dispose:()=>{for(const effect of installed)effect?.cleanup?.()},setRecovery:value=>{recovery=value},request:target=>{assert.equal(typeof stage.dyofficeOpenEditorSettings,'function');stage.dyofficeOpenEditorSettings(target,caller)}}
}
test('Shell preserves a file route selected before its first effect',async()=>{
 const id='20000000-0000-0000-0000-000000000002',requested=entryHash(id),resolved=[]
 const f=fixture({openInitial:false,initialHash:requested,resolveOpenDocument:async fileId=>{
  resolved.push(fileId);return {id:fileId,name:'example.pdf',format:'pdf',src:`/native-pdf/?fileId=${fileId}`}
 }})
 await new Promise(resolve=>setImmediate(resolve))
 assert.equal(f.location.hash,requested)
 assert.deepEqual(resolved,[id])
 assert.equal(f.activeFrame()?.props.children[0].props.file.id,id)
})
test('Shell does not reopen an initial route when its queued hashchange arrives',async()=>{
 const id='20000000-0000-0000-0000-000000000002',resolved=[]
 let release
 const pending=new Promise(resolve=>{release=resolve})
 const f=fixture({openInitial:false,initialHash:entryHash(id),resolveOpenDocument:fileId=>{resolved.push(fileId);return pending}})
 f.emit('hashchange')
 release({id,name:'example.pdf',format:'pdf',src:`/native-pdf/?fileId=${id}`})
 await new Promise(resolve=>setImmediate(resolve))
 assert.deepEqual(resolved,[id])
 assert.equal(f.activeFrame()?.props.children[0].props.file.id,id)
})
test('restoring a requested file does not overwrite a new hash while metadata is pending',async()=>{
 const restored='10000000-0000-0000-0000-000000000001',requested='20000000-0000-0000-0000-000000000002'
 const sourceCode=source.slice(source.indexOf('async function restore('),source.indexOf('let logoutPending'))
 const {code:restoreCode}=await transform(sourceCode,{loader:'tsx',target:'es2022'})
 const location={hash:entryHash(restored),href:'https://office.example/'+entryHash(restored)},documentTabs=createDocumentTabs()
 let release,started
 const isStarted=new Promise(resolve=>{started=resolve})
 const metadata=new Promise(resolve=>{release=resolve})
 const bound={async request(path){
  if(path==='/api/v1/auth/me')return {user:{id:'user'},deploymentId:'test'}
  if(path==='/api/v1/capabilities')return {}
  assert.equal(path,`/api/v1/files/${restored}`)
  started()
  return metadata
 }}
 const restore=runInNewContext(restoreCode+'\nrestore',{
  client:{},createSourceWorkspaceSession:async()=>({bound}),preferenceSession:{bind(){}},globalSettingsSession:{bind(){}},workspaceSession:{bind(){}},
  preferences:{getPreferences:async()=>({})},user:null,capabilities:{},initialLanguage:'zh',assistantVisible:true,userSkills:null,sourceWorkspace:null,
  document:{documentElement:{dataset:{}}},window:{sessionStorage:{getItem:()=>null}},createUserSkillsClient(){},installBridge(){},createEntryRecovery,
  entryRecovery:undefined,entryRecoveryNotice:'',createDocumentTabs,documentTabs,resolveEntrySnapshot,entryHash,parseEntryHash,
  resolvedDocument:(_capabilities,id,_metadata)=>({id,name:'previous.pdf',format:'pdf',src:`/native-pdf/?fileId=${id}`}),
  URL,location,history:{replaceState(_data,_title,hash){location.hash=hash}},
 })
 const result=restore()
 await isStarted
 location.hash=entryHash(requested)
 release({})
 await result
 assert.equal(location.hash,entryHash(requested))
 assert.equal(documentTabs.documents()[0]?.id,restored)
})
test('editor settings open host dialogs and skills tab without replacing the iframe',()=>{
 const f=fixture(),frame=f.activeFrame();assert.equal(frame.props.children[0].type,'document-frame')
 f.request('skills');assert.equal(f.dialog().props.title,'个人设置');assert.equal(f.content().props.page,'settings');assert.equal(f.content().props.settingsTab,'skills')
 f.request('models');assert.equal(f.content().props.page,'global')
 assert.equal(f.activeFrame().props.key,frame.props.key)
 assert.deepEqual(f.activeFrame().props.children[0].props.file,frame.props.children[0].props.file)
})
test('existing pending or dirty configuration keeps its dialog when its guard refuses switching',()=>{
 const f=fixture();f.request('models');f.content().props.onCloseGuardChange(()=>false);f.request('skills');assert.equal(f.content().props.page,'global');assert.match(f.values[0],/完成|保存|当前/)
})
test('non-admin model settings, foreign frames and recovery requests stay unavailable',()=>{
 const personal=fixture({roles:['personal']});personal.request('models');assert.equal(personal.dialog(),undefined);assert.match(personal.values[0],/管理员/)
 const f=fixture();assert.equal(typeof f.stage.dyofficeOpenEditorSettings,'function');f.stage.dyofficeOpenEditorSettings('skills',{location:{origin:'http://localhost'}});assert.equal(f.dialog(),undefined)
 f.setRecovery(true);f.render();f.request('skills');assert.equal(f.dialog(),undefined)
})
test('reselecting skills preserves the existing settings component and its dirty guard',()=>{
 const f=fixture();f.request('skills');let checked=0;f.content().props.onCloseGuardChange(()=>{checked++;return false});f.request('skills');assert.equal(f.content().props.page,'settings');assert.equal(checked,0)
})

test('session-ended immediately blocks the host capability and unmount removes it',()=>{
 const f=fixture();f.endSession();f.request('skills');assert.equal(f.dialog(),undefined)
 f.dispose();assert.equal(f.stage.dyofficeOpenEditorSettings,undefined)
})

test('ordinary personal settings reopens on the original account tab after editor skills settings closes',()=>{
 const f=fixture();f.request('skills');f.dialog().props.onClose()
 f.app().props.homeProps.accountEntry.props.onOpen('settings')
 assert.equal(f.content().props.settingsTab,'account')
})
