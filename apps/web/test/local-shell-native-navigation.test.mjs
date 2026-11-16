import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {runInNewContext} from 'node:vm'
import {transform} from 'esbuild'

// Execute the real Home open/upload bodies without mounting unrelated React UI.
const source=await readFile(new URL('../src/shell/local-main.tsx',import.meta.url),'utf8')
const slice=source.slice(source.indexOf('async function open(id:'),source.indexOf('async function browse()'))
assert.ok(slice.includes('async function upload('))
const {code}=await transform(slice,{loader:'ts',target:'es2022'})
function fixture({format='xlsx',capability='editable',missingCapability=false,fail,download='/api/v1/files/file/content?revision=rev'}={}){
 const calls=[],navigated=[],downloads=[],notices=[]
 const result={format,name:'book.'+format,file:{fileId:'file'},downloadEndpoint:download}
 const client={async request(path,method){calls.push([path,method]);if(fail&&(fail==='read'||method==='POST'))throw new Error('Forbidden');return result},async upload(file){calls.push(['upload',file.name]);return result}}
 const context={client,capabilities:{docx:'editable',...(missingCapability?{}:{xlsx:capability})},notifyFilesChanged(){calls.push(['changed'])},notice:x=>notices.push(x),location:{assign:x=>navigated.push(x)},document:{createElement(){return {click(){downloads.push([this.href,this.download])}}}},encodeURIComponent}
 const api=runInNewContext(code+'\n({open,upload})',context)
 return {api,calls,navigated,downloads,notices}
}
test('Home opens editable XLSX in its guarded top-level native entry',async()=>{
 const f=fixture();await f.api.open('file');assert.deepEqual(f.navigated,['/native-xlsx/?fileId=file']);assert.equal(f.downloads.length,0)
 assert.deepEqual(f.calls.slice(0,2),[['/api/v1/files/file',undefined],['/api/v1/workspace/files/file/open','POST']])
})
test('upload uses validated XLSX format and opens the native entry instead of download notice',async()=>{
 const f=fixture();await f.api.upload({name:'BOOK.XLSX'});assert.deepEqual(f.navigated,['/native-xlsx/?fileId=file']);assert.equal(f.notices.length,0)
})
test('DOCX native navigation is retained',async()=>{
 const f=fixture({format:'docx'});await f.api.open('file');assert.deepEqual(f.navigated,['/native-docx/?fileId=file'])
})
for(const capability of ['unsupported','readonly',undefined])test(`noneditable XLSX keeps original download (${capability})`,async()=>{
 const f=fixture({capability,missingCapability:capability===undefined});await f.api.open('file');assert.equal(f.navigated.length,0);assert.equal(f.downloads.length,1)
})
for(const format of ['pptx','pdf'])test(`${format} still downloads the original`,async()=>{
 const f=fixture({format});await f.api.open('file');assert.equal(f.navigated.length,0);assert.equal(f.downloads.length,1)
})
for(const fail of ['read','activity'])test(`failed ${fail} authorization cannot navigate or download`,async()=>{
 const f=fixture({fail});await assert.rejects(f.api.open('file'),/Forbidden/);assert.equal(f.navigated.length,0);assert.equal(f.downloads.length,0)
})
test('download fallback rejects an external endpoint',async()=>{
 const f=fixture({capability:'unsupported',download:'https://other.example/file'});await assert.rejects(f.api.open('file'));assert.equal(f.downloads.length,0)
})
test('failed upload opening releases busy without blindly retrying',async()=>{
 const f=fixture({fail:'read'});await assert.rejects(f.api.upload({name:'a.xlsx'}));await assert.rejects(f.api.upload({name:'b.xlsx'}));assert.equal(f.calls.filter(x=>x[0]==='upload').length,2)
})
