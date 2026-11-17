import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {runInNewContext} from 'node:vm'
import {transform} from 'esbuild'

// Exercise actual entry functions. Authorization/worker isolation stays server-side.
const source=await readFile(new URL('../src/shell/local-main.tsx',import.meta.url),'utf8')
const slice=source.slice(source.indexOf('async function open(id:'),source.indexOf('const unsupported='))
assert.ok(slice.includes('async function browse()'))
const {code}=await transform(slice,{loader:'ts',target:'es2022'})
function fixture({format='xlsx',capabilities={docx:'editable',xlsx:'editable'},fail=false,pending=false}={}) {
 const calls=[],navigated=[],inputs=[];let release
 const result={format,file:{fileId:'id /?#'}}
 const client={async request(path){calls.push(['read',path]);if(fail)throw new Error('Forbidden');return {...result,file:{fileId:decodeURIComponent(path.split('/').at(-1))}}},async upload(file){calls.push(['upload',file.name]);if(pending)await new Promise(r=>release=r);return result}}
 const api=runInNewContext(code+'\n({open,upload,browse})',{client,capabilities,notifyFilesChanged(){calls.push(['changed'])},notice(){},location:{assign:x=>navigated.push(x)},document:{createElement(){const input={click(){inputs.push(this)}};return input}},encodeURIComponent})
 return {api,calls,navigated,inputs,release:()=>release()}
}
for(const format of ['docx','xlsx'])test(`editable ${format} opens guarded top-level route with encoded id`,async()=>{
 const f=fixture({format});await f.api.open('id /?#');assert.deepEqual(f.navigated,[`/native-${format}/?fileId=id%20%2F%3F%23`]);assert.deepEqual(f.calls.slice(0,2),[['read','/api/v1/files/id%20%2F%3F%23'],['read','/api/v1/workspace/files/id%20%2F%3F%23/open']])
})
for(const value of ['readonly','unsupported',undefined])test(`XLSX ${value} capability cannot navigate and invalid download is rejected`,async()=>{
 const f=fixture({capabilities:{docx:'editable',xlsx:value}});await assert.rejects(f.api.open('id'));assert.equal(f.navigated.length,0)
})
for(const format of ['pptx','pdf','unknown'])test(`${format} does not gain native navigation from malformed file metadata`,async()=>{
 const f=fixture({format,capabilities:{[format]:'editable'}});await assert.rejects(f.api.open('id'));assert.equal(f.navigated.length,0)
})
test('failed file authorization prevents navigation',async()=>{const f=fixture({fail:true});await assert.rejects(f.api.open('id'),/Forbidden/);assert.equal(f.navigated.length,0)})
test('XLSX import uses validated server format then opens',async()=>{const f=fixture();await f.api.upload({name:'BOOK.XLSX'});assert.equal(f.navigated.length,1)})
test('disabled native import still permits original-file storage',async()=>{const f=fixture({capabilities:{docx:'editable'}});await f.api.upload({name:'book.xlsx'});assert.equal(f.navigated.length,0);assert.equal(f.calls.filter(x=>x[0]==='upload').length,1)})
test('invalid import rejects before uploading',async()=>{const f=fixture();await assert.rejects(f.api.upload({name:'book.exe'}));assert.equal(f.calls.length,0)})
test('server-reported non-native format is not navigated',async()=>{const f=fixture({format:'pdf'});await f.api.upload({name:'book.xlsx'});assert.equal(f.navigated.length,0)})
test('failed open releases busy and never retries import automatically',async()=>{const f=fixture({fail:true});for(let i=0;i<2;i++)await assert.rejects(f.api.upload({name:'book.xlsx'}),/Forbidden/);assert.equal(f.calls.filter(x=>x[0]==='upload').length,2)})
test('concurrent imports reject duplicate request',async()=>{const f=fixture({pending:true});const first=f.api.upload({name:'book.xlsx'});await assert.rejects(f.api.upload({name:'book.xlsx'}),/正在导入/);f.release();await first;assert.equal(f.calls.filter(x=>x[0]==='upload').length,1)})
test('picker offers all four import formats without enabling native capabilities',async()=>{const f=fixture({capabilities:{xlsx:'editable'}});await f.api.browse();assert.equal(f.inputs[0].accept,'.docx,.xlsx,.pptx,.pdf')})
test('picker without native capabilities permits original-file import',async()=>{const f=fixture({capabilities:{}});await f.api.browse();assert.equal(f.inputs[0].accept,'.docx,.xlsx,.pptx,.pdf')})
test('DOCX upload retains its native route',async()=>{const f=fixture({format:'docx'});await f.api.upload({name:'BOOK.DOCX'});assert.deepEqual(f.navigated,['/native-docx/?fileId=id%20%2F%3F%23'])})
test('picker includes both advertised formats',async()=>{const f=fixture();await f.api.browse();assert.equal(f.inputs[0].accept,'.docx,.xlsx,.pptx,.pdf')})
