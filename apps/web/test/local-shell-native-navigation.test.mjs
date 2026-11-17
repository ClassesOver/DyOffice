import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {runInNewContext} from 'node:vm'
import {transform} from 'esbuild'
const source=await readFile(new URL('../src/shell/local-main.tsx',import.meta.url),'utf8')
const slice=source.slice(source.indexOf('async function open(id:'),source.indexOf('const unsupported='))
const {code}=await transform(slice,{loader:'ts',target:'es2022'})
function fixture({format='docx',capability='editable',fail=false,download,revision='rev',pending=false}={}){
 const calls=[],opened=[],navigated=[],inputs=[];let release
 const result={name:`test.${format}`,format,file:{fileId:'file',revision},downloadEndpoint:download??`/api/v1/files/file/content?revision=${revision}`}
 const client={async request(path,method){calls.push([path,method]);if(fail)throw Error('Forbidden');return result},async upload(file){calls.push(['upload',file.name]);if(pending)await new Promise(r=>release=r);return result}}
 const api=runInNewContext(code+'\n({open,upload,browse})',{client,capabilities:{[format]:capability},documentTabs:{open:x=>opened.push(x)},notifyFilesChanged(){},notice(){},showUpload(){inputs.push({dialog:true})},location:{assign:x=>navigated.push(x)},document:{createElement(){return {click(){inputs.push(this)}}}},encodeURIComponent})
 return {api,calls,opened,navigated,inputs,release:()=>release()}
}
for(const format of ['docx','xlsx','pptx','pdf'])for(const capability of ['editable','unsupported'])test(`${format} ${capability} opens in-app without navigating the browser`,async()=>{
 const f=fixture({format,capability});await f.api.open('file');assert.equal(f.opened.length,1);assert.equal(f.opened[0].id,'file');assert.equal(f.opened[0].format,format);assert.equal(f.opened[0].src,format!=='pdf'&&capability==='editable'?`/native-${format}/?fileId=file`:'/api/v1/files/file/content?revision=rev');assert.equal(f.navigated.length,0);assert.deepEqual(f.calls.slice(0,2),[['/api/v1/files/file',undefined],['/api/v1/workspace/files/file/open','POST']])
})
for(const download of ['https://evil.example/file','/api/v1/files/other/content?revision=rev','/api/v1/files/file/content?revision=other'])test(`unbound content URL rejected: ${download}`,async()=>{const f=fixture({download});await assert.rejects(f.api.open('file'));assert.equal(f.opened.length,0)})
test('unknown format rejected',async()=>{const f=fixture({format:'exe'});await assert.rejects(f.api.open('file'));assert.equal(f.opened.length,0)})
test('failed authorization never opens a tab',async()=>{const f=fixture({fail:true});await assert.rejects(f.api.open('file'),/Forbidden/);assert.equal(f.opened.length,0)})
for(const format of ['docx','xlsx','pptx','pdf'])test(`${format} import opens in-app even without editable runtime`,async()=>{const f=fixture({format,capability:'unsupported'});await f.api.upload({name:`test.${format}`});assert.equal(f.opened.length,1);assert.equal(f.navigated.length,0)})
test('concurrent imports cannot duplicate an upload',async()=>{const f=fixture({pending:true});const first=f.api.upload({name:'a.docx'});await assert.rejects(f.api.upload({name:'b.docx'}),/正在导入/);f.release();await first;assert.equal(f.calls.filter(x=>x[0]==='upload').length,1)})
test('failed opening releases upload lock',async()=>{const f=fixture({fail:true});for(let i=0;i<2;i++)await assert.rejects(f.api.upload({name:'a.docx'}));assert.equal(f.calls.filter(x=>x[0]==='upload').length,2)})
test('invalid extension rejected before upload',async()=>{const f=fixture();await assert.rejects(f.api.upload({name:'a.exe'}));assert.equal(f.calls.length,0)})
test('import entry opens the upload dialog without uploading a file',async()=>{const f=fixture();await f.api.browse();assert.deepEqual(f.inputs,[{dialog:true}]);assert.equal(f.calls.length,0)})
