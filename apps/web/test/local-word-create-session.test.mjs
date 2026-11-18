import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {runInNewContext} from 'node:vm'
import {transform} from 'esbuild'
const source=await readFile(new URL('../src/shell/local-main.tsx',import.meta.url),'utf8')
const start=source.indexOf(' window.aiOffice.newDoc=')
assert.ok(start>=0)
const {code}=await transform(source.slice(start,source.indexOf('\n window.aiOffice.newSheet=',start)),{loader:'ts',target:'es2022'})
test('Word creation retains its initiating workspace proof across template loading',async()=>{
 let release;const uploads=[]
 const context={window:{aiOffice:{}},sourceWorkspace:{bound:{proof:'a'.repeat(43)}},capabilities:{docx:'editable'},blankDocx:'/blank.docx',File,
  fetch:()=>new Promise(resolve=>release=resolve),unsupported:()=>{throw Error('unexpected')},upload:async(file,proof)=>uploads.push({file,proof})}
 runInNewContext(code,context)
 const creating=context.window.aiOffice.newDoc()
 context.sourceWorkspace={bound:{proof:'b'.repeat(43)}}
 release(new Response('trusted blank template'))
 await creating
 assert.equal(uploads.length,1);assert.equal(uploads[0].proof,'a'.repeat(43));assert.equal(uploads[0].file.name,'未命名.docx')
})
test('Word creation without a verified workspace does not fetch a template or upload',async()=>{
 const context={window:{aiOffice:{}},sourceWorkspace:undefined,capabilities:{docx:'editable'},blankDocx:'/blank.docx',File,
  fetch:()=>assert.fail('unverified fetch'),unsupported:()=>assert.fail('unexpected'),upload:()=>assert.fail('unverified upload')}
 runInNewContext(code,context)
 await assert.rejects(context.window.aiOffice.newDoc(),/登录状态未核验/)
})
