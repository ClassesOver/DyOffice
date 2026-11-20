import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {runInNewContext} from 'node:vm'
import {transform} from 'esbuild'
import {createDocumentTabs} from '../src/shell/document-tabs.ts'
import {createEntryNavigator} from '../src/shell/workspace-entry-navigation.ts'
import {entryHash,parseEntryHash} from '../src/shell/workspace-entry-recovery.ts'
import {localNewFormats} from '../src/shell/local-new-sheet.ts'
const source=await readFile(new URL('../src/shell/local-main.tsx',import.meta.url),'utf8')
const {code}=await transform(source.slice(source.indexOf('function Shell('),source.indexOf('function Login(')),{loader:'tsx',target:'es2022',jsxFactory:'jsx'})
function fixture({roles=['personal','config_admin'],recovery=false}={}){
 const values=[],refs=[],effects=[],installed=[],listeners=new Set(),caller={location:{origin:'http://localhost'}};let stateIndex=0,refIndex=0,effectIndex=0
 const documentTabs=createDocumentTabs(),id='10000000-0000-0000-0000-000000000001'
 documentTabs.open({id,format:'docx',name:'example.docx',src:`/native-docs/?id=${id}`})
 const stage={location:{origin:'http://localhost'},addEventListener(){},removeEventListener(){}}
 const context={
  jsx:(type,props,...children)=>({type,props:{...props,children}}),
  useState:initial=>{const i=stateIndex++;if(!(i in values))values[i]=typeof initial==='function'?initial():initial;return[values[i],value=>{values[i]=typeof value==='function'?value(values[i]):value}]},
  useRef:initial=>{const i=refIndex++;return refs[i]??(refs[i]={current:initial})},useCallback:fn=>fn,
  useEffect:(fn,deps)=>{const i=effectIndex++,old=installed[i];if(!old||!deps||deps.some((value,index)=>!Object.is(value,old.deps[index])))effects.push(()=>{old?.cleanup?.();installed[i]={deps,cleanup:fn()}})},
  client:{onSessionEnded:fn=>{listeners.add(fn);return()=>listeners.delete(fn)}},documentTabs,entryRecoveryNotice:'',entryRecovery:undefined,sourceWorkspace:undefined,
  createEntryNavigator,entryHash,parseEntryHash,localNewFormats,resolveOpenDocument:async()=>{throw Error('Unexpected document navigation')},
  URLSearchParams,location:{hash:entryHash(id),search:''},history:{replaceState(){},pushState(){}},window:stage,
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
 return {stage,caller,values,dialog,content,app,activeFrame,render,endSession:()=>{for(const listener of listeners)listener()},dispose:()=>{for(const effect of installed)effect?.cleanup?.()},setRecovery:value=>{recovery=value},request:target=>{assert.equal(typeof stage.dyofficeOpenEditorSettings,'function');stage.dyofficeOpenEditorSettings(target,caller)}}
}
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
