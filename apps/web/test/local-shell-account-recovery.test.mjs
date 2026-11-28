import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {runInNewContext} from 'node:vm'
import {transform} from 'esbuild'
const source=await readFile(new URL('../src/shell/local-main.tsx',import.meta.url),'utf8')
const {code}=await transform(source.slice(source.indexOf('function WorkspacePageContent('),source.indexOf('function Account(')),{loader:'tsx',target:'es2022',jsxFactory:'jsx'})
function fixture(page){
 const events=[]
 const render=runInNewContext(code+'\nWorkspacePageContent',{
  jsx:(type,props,...children)=>({type,props:{...props,children}}),useState:()=>[0,()=>{}],useMemo:run=>run(),sourceWorkspace:undefined,
  user:{id:'me',roles:['personal','config_admin']},WorkspaceSettings:'settings',LocalAdminPanel:'admin',
  sessionsClient:{},historyClient:{},preferences:{},saveWorkspacePreferences(){},adminClient:{},userSkills:null,
  client:{endSession:reason=>events.push(['recovery',reason]),invalidateSession:()=>events.push(['invalidate'])},
  location:{replace:path=>events.push(['navigate',path])},
 })
 const result=render({page,onClose(){},onCloseGuardChange(){}})
 return {events,props:page==='users'?result.props.children[0].props:result.props}
}
test('successful current-session revocation enters recovery without navigating away from editors',()=>{
 const f=fixture('settings');f.props.security.onCurrentRevoked();assert.deepEqual(f.events,[['recovery','expired']])
})
test('successful own-authority changes enter recovery without navigating away from editors',()=>{
 const f=fixture('users');f.props.onOwnAuthorityChanged();assert.deepEqual(f.events,[['recovery','expired']])
})
