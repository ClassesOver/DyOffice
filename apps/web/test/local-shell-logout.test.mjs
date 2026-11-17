import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {runInNewContext} from 'node:vm'
import {transform} from 'esbuild'
const source=await readFile(new URL('../src/shell/local-main.tsx',import.meta.url),'utf8')
const {code}=await transform(source.slice(source.indexOf('async function logout()'),source.indexOf('function WorkspacePageContent')),{loader:'ts',target:'es2022'})
function fixture({cancel=false,failDispose=false,failLogout=false}={}){
 const closed=[],events=[]
 const frames=['a','b'].map(id=>({dataset:{documentId:id},contentWindow:{dyofficeEditorCanClose:async()=>{events.push('check:'+id);return !(id==='b'&&cancel)},dyofficeEditorDispose:async()=>{events.push('dispose:'+id);return !(id==='b'&&failDispose)}}}))
 const logout=runInNewContext(code+'\nlogout',{document:{querySelectorAll:()=>frames},documentTabs:{close:async id=>closed.push(id)},client:{logout:async()=>{events.push('logout');if(failLogout)throw Error('network')}},location:{replace:()=>events.push('redirect')}})
 return {logout,closed,events}
}
test('cancelled later editor leaves every editor intact and does not invalidate the session',async()=>{const f=fixture({cancel:true});await f.logout();assert.deepEqual(f.closed,[]);assert.deepEqual(f.events,['check:a','check:b'])})
test('later lease release failure removes already disposed tabs and preserves the failing editor',async()=>{const f=fixture({failDispose:true});await f.logout();assert.deepEqual(f.closed,['a']);assert.ok(!f.events.includes('logout'))})
test('logout network failure cannot leave disposed editors as empty tabs',async()=>{const f=fixture({failLogout:true});await assert.rejects(f.logout(),/network/);assert.deepEqual(f.closed,['a','b']);assert.ok(!f.events.includes('redirect'))})
