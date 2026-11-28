import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {runInNewContext} from 'node:vm'
import {transform} from 'esbuild'
import {readOpenDocument} from '../src/shell/document-entry-reader.ts'
import {isWorkspaceFileName,workspaceFileImports} from '../src/shell/workspace-file-formats.ts'

// Execute the real Home open/upload bodies without mounting unrelated React UI.
const source=await readFile(new URL('../src/shell/local-main.tsx',import.meta.url),'utf8')
const slice=source.slice(source.indexOf('async function resolveOpenDocument(id:'),source.indexOf('async function browse()'))
assert.ok(slice.includes('async function upload('))
const {code}=await transform(slice,{loader:'ts',target:'es2022'})
function fixture({verified=true,format='xlsx',capability='editable',missingCapability=false,fail,download='/api/v1/files/file/content?revision=rev'}={}){
 const calls=[],navigated=[],downloads=[],notices=[]
 const result={format,name:'book.'+format,file:{fileId:'file',revision:'rev'},downloadEndpoint:download}
 const client={async request(path,method){calls.push([path,method]);if(fail&&(fail==='read'||method==='POST'))throw new Error('Forbidden');return result},async upload(file,proof){assert.equal(proof,'a'.repeat(43));calls.push(['upload',file.name]);return result}}
 const opened=[]
 const context={documentTabs:{renderedDocuments:()=>opened,reserveOpen:()=>({renameVersion:0,sequence:1}),open:x=>opened.push(x)},client,sourceWorkspace:{bound:{request:client.request,...(verified?{proof:'a'.repeat(43)}:{})}},readOpenDocument,isWorkspaceFileName,workspaceFileImports,capabilities:{docx:'editable',...(missingCapability?{}:{xlsx:capability})},notifyFilesChanged(){calls.push(['changed'])},notice:x=>notices.push(x),location:{assign:x=>navigated.push(x)},document:{createElement(){return {click(){downloads.push([this.href,this.download])}}}},encodeURIComponent}
 const actions=runInNewContext(code+'\n({open,upload})',context)
 const api={...actions,upload:file=>actions.upload(file,verified?'a'.repeat(43):undefined)}
 return {api,calls,navigated,downloads,notices,opened}
}
test('editable XLSX opens native editor in an app tab',async()=>{
 const f=fixture();await f.api.open('file');assert.equal(f.opened[0].src,'/native-xlsx/?fileId=file');assert.equal(f.navigated.length,0);assert.equal(f.downloads.length,0)
 assert.deepEqual(f.calls.slice(0,2),[['/api/v1/files/file',undefined],['/api/v1/workspace/files/file/open','POST']])
})
test('editable XLSX import opens native editor tab',async()=>{
 const f=fixture();await f.api.upload({name:'BOOK.XLSX'});assert.equal(f.opened[0].src,'/native-xlsx/?fileId=file');assert.equal(f.navigated.length,0);assert.equal(f.notices.length,0)
})
test('DOCX opens a native editor tab',async()=>{
 const f=fixture({format:'docx'});await f.api.open('file');assert.equal(f.opened[0].src,'/native-docx/?fileId=file');assert.equal(f.navigated.length,0)
})
for(const capability of ['unsupported','readonly',undefined])test(`noneditable XLSX opens a readonly preview tab (${capability})`,async()=>{
 const f=fixture({capability,missingCapability:capability===undefined});await f.api.open('file');assert.equal(f.navigated.length,0);assert.equal(f.downloads.length,0);assert.equal(f.opened[0].src,'/api/v1/files/file/content?revision=rev')
})
test('noneditable PPTX opens readonly preview in-app',async()=>{
 const f=fixture({format:'pptx'});await f.api.open('file');assert.equal(f.navigated.length,0);assert.equal(f.downloads.length,0);assert.equal(f.opened[0].src,'/api/v1/files/file/content?revision=rev')
})
test('PDF opening reports unavailable editing without recording an open or starting a download',async()=>{
 const f=fixture({format:'pdf'});await assert.rejects(f.api.open('file'),/当前 PDF 编辑器未启用，请下载原件/)
 assert.deepEqual(f.calls,[['/api/v1/files/file',undefined]]);assert.equal(f.opened.length,0);assert.equal(f.navigated.length,0);assert.equal(f.downloads.length,0)
})
for(const fail of ['read','activity'])test(`failed ${fail} authorization cannot navigate or download`,async()=>{
 const f=fixture({fail});await assert.rejects(f.api.open('file'),/Forbidden/);assert.equal(f.navigated.length,0);assert.equal(f.downloads.length,0)
})
test('download fallback rejects an external endpoint',async()=>{
 const f=fixture({capability:'unsupported',download:'https://other.example/file'});await assert.rejects(f.api.open('file'));assert.equal(f.downloads.length,0)
})
test('failed upload opening releases busy without blindly retrying',async()=>{
 const f=fixture({format:'docx',fail:'read'});await assert.rejects(f.api.upload({name:'a.docx'}));await assert.rejects(f.api.upload({name:'b.docx'}));assert.equal(f.calls.filter(x=>x[0]==='upload').length,2)
})

for(const download of ['/api/v1/files/other/content?revision=rev','/api/v1/files/file/content?revision=other','/api/v1/files/file/content?revision=rev#x','/api/v1/files/../admin/config','/api/v1/files/file/content?revision=rev&redirect=https://evil.example'])test(`rejects unbound download ${download}`,async()=>{const f=fixture({capability:'unsupported',download});await assert.rejects(f.api.open('file'));assert.equal(f.downloads.length,0)})

test('unverified workspace cannot upload or open a file',async()=>{
 const f=fixture({verified:false});await assert.rejects(f.api.upload({name:'a.xlsx'}),/登录状态未核验/);assert.deepEqual(f.calls,[]);assert.equal(f.opened.length,0);assert.equal(f.navigated.length,0);assert.equal(f.downloads.length,0)
})
