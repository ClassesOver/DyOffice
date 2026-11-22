import test from 'node:test'
import assert from 'node:assert/strict'
import {createDocsBridge} from '../../src/editors/docs-bridge.ts'
import {readOpenDocument} from '../../src/shell/document-entry-reader.ts'
const id='11111111-1111-4111-8111-111111111111',revision='22222222-2222-4222-8222-222222222222'
const reference=`/files/${id}/revisions/${revision}`
const path=`${reference}/${encodeURIComponent('资料.docx')}`
const file={path,name:'资料.docx',ext:'docx',folder:'知识库',folderPath:'',sizeBytes:123}
test('workspace navigation rejects a superseded citation before selecting or marking the file opened',async()=>{
 const calls=[]
 const workspace={bound:{request:async(url,method)=>{
  calls.push([url,method])
  return {name:file.name,format:'docx',file:{fileId:id,revision},downloadEndpoint:`/api/v1/files/${id}/content?revision=${revision}`}
 }}}
 await assert.rejects(readOpenDocument(workspace,{docx:'editable'},id,id),/cited revision/)
 assert.deepEqual(calls,[[`/api/v1/files/${id}`,undefined]])
 const current=await readOpenDocument(workspace,{docx:'editable'},id,revision)
 assert.equal(new URL(current.src,'https://office.example').searchParams.get('sourceRevision'),revision)
})
function fixture(t,request){const previous=globalThis.window,opened=[];globalThis.window={location:{origin:'https://office.example'},parent:{location:{origin:'https://office.example'},dyofficeOpenKnowledgeSource:async (id,revision)=>opened.push({id,revision})}};t.after(()=>{globalThis.window=previous});const bridge=createDocsBridge({getState:()=>({name:'current.docx'})},id,{language:'en'},()=>{},undefined,{knowledgeRequest:request});t.after(()=>bridge.dispose());return {bridge,opened}}
test('Word knowledge bridge uses the bound request and version-pinned corpus for search, paging and navigation',async t=>{
 const calls=[]
 const {bridge,opened}=fixture(t,async(url,method='GET',body)=>{calls.push({url,method,body});if(url.endsWith('/files'))return [file];if(url.endsWith('/search'))return [{...file,snippet:'literal match'}];return {text:'content',totalChars:24007,offset:Number(new URL(url,'https://office.example').searchParams.get('offset'))}})
 assert.deepEqual(await bridge.api.kbList(),[{...file,path:reference}])
 assert.equal((await bridge.api.kbSearch({q:'literal',limit:5}))[0].path,reference)
 assert.deepEqual(calls[1],{url:'/api/v1/knowledge/search',method:'POST',body:{q:'literal',limit:5,paths:[path]}})
 assert.deepEqual(await bridge.api.kbRead(reference,24000),{text:'content',totalChars:24007,offset:24000})
 assert.equal(calls[2].url,`/api/v1/knowledge/read?path=${encodeURIComponent(path)}&offset=24000`)
 await bridge.api.openSourcePath(reference)
 assert.deepEqual(opened,[{id,revision}])
})
test('a citation with mixed escaping opens only the matching canonical knowledge source',async t=>{
 const reads=[]
 const {bridge,opened}=fixture(t,async url=>{
  if(url.endsWith('/files'))return [file]
  reads.push(new URL(url,'https://office.example').searchParams.get('path'))
  return {text:'content',totalChars:7,offset:0}
 })
 await bridge.api.kbList()
 const citation=path.replace('%E8%B5%84%E6%96%99','%25E8%25B5%2584%25E6%96%99')
 await assert.rejects(bridge.api.kbRead(citation,0))
 await assert.rejects(bridge.api.openSourcePath(citation.replace(revision,id)))
 await assert.rejects(bridge.api.openSourcePath(citation.replace('%99','%90')))
 assert.equal(bridge.resolveKnowledgeCitation(citation),reference)
 await bridge.api.openSourcePath(citation)
 assert.deepEqual(reads,[path])
 assert.deepEqual(opened,[{id,revision}])
})
test('unknown/local/external citation paths and a foreign parent never navigate',async t=>{
 let reads=0
 const {bridge,opened}=fixture(t,async url=>url.endsWith('/files')?[file]:(reads++,{text:'x',totalChars:1,offset:0}))
 await bridge.api.kbList()
 for(const value of ['/etc/passwd','https://evil.example'+path,reference.replace(revision,id),reference+'?x=1',path.replace(revision,id),path.replace(encodeURIComponent('资料'),'other'),path+'?x=1',path.replace('%E8%B5%84%E6%96%99.docx','..%2Fsecret.docx')]){
  await assert.rejects(bridge.api.kbRead(value,0));await assert.rejects(bridge.api.openSourcePath(value))
 }
 assert.equal(reads,0);assert.deepEqual(opened,[])
 window.parent.location.origin='https://foreign.example';await assert.rejects(bridge.api.openSourcePath(path));assert.deepEqual(opened,[])
})
test('failed corpus refresh and disposal revoke cached paths and late responses',async t=>{
 let fail=false,release
 const {bridge}=fixture(t,async url=>{if(fail)throw Error('session changed');if(url.endsWith('/files'))return [file];return new Promise(resolve=>release=resolve)})
 await bridge.api.kbList();fail=true;await assert.rejects(bridge.api.kbList());await assert.rejects(bridge.api.kbRead(path,0))
 fail=false;await bridge.api.kbList();const reading=bridge.api.kbRead(path,0);bridge.dispose();release({text:'x',totalChars:1,offset:0});await assert.rejects(reading);await assert.rejects(bridge.api.kbList())
})
test('knowledge search rejects results outside the current pinned snapshot',async t=>{
 let returnedPath
 const {bridge}=fixture(t,async url=>url.endsWith('/files')?[file]:[{...file,path:returnedPath,snippet:'unexpected source'}])
 await bridge.api.kbList()
 for(const unexpected of [path.replace(revision,id),reference,reference+'/other.docx']){
  returnedPath=unexpected
  await assert.rejects(bridge.api.kbSearch({q:'test'}))
 }
})

test('knowledge paging preserves requested offsets beyond EOF and search keeps pinned labels during rename',async t=>{
 const {bridge}=fixture(t,async url=>url.endsWith('/files')?[file]:url.endsWith('/search')?[{path,name:'renamed.docx',ext:'docx',folder:'moved',snippet:'same revision'}]:{text:'',totalChars:3,offset:100})
 await bridge.api.kbList()
 assert.deepEqual(await bridge.api.kbRead(path,100),{text:'',totalChars:3,offset:100})
 assert.deepEqual(await bridge.api.kbSearch({q:'same'}),[{path:reference,name:file.name,ext:file.ext,folder:file.folder,snippet:'same revision'}])
})

test('a corpus refresh revokes both forms of a superseded reference while accepting the new revision',async t=>{
 const nextRevision='33333333-3333-4333-8333-333333333333'
 let current=file,reads=0
 const {bridge,opened}=fixture(t,async url=>url.endsWith('/files')?[current]:(reads++,{text:'x',totalChars:1,offset:0}))
 await bridge.api.kbList()
 current={...file,path:path.replace(revision,nextRevision)}
 const [replacement]=await bridge.api.kbList()
 for(const obsolete of [reference,path]){
  await assert.rejects(bridge.api.openSourcePath(obsolete))
  await assert.rejects(bridge.api.kbRead(obsolete,0))
 }
 await bridge.api.openSourcePath(replacement.path)
 assert.equal(reads,1)
 assert.deepEqual(opened,[{id,revision:nextRevision}])
})

test('renaming a source keeps its reference and sends the new authorized server path',async t=>{
 const renamed={...file,name:'Q2 (最终).docx',path:`${reference}/${encodeURIComponent('Q2 (最终).docx')}`}
 let current=file
 const reads=[]
 const {bridge,opened}=fixture(t,async url=>{
  if(url.endsWith('/files'))return [current]
  reads.push(new URL(url,'https://office.example').searchParams.get('path'))
  return {text:'x',totalChars:1,offset:0}
 })
 const [original]=await bridge.api.kbList()
 current=renamed
 const [after]=await bridge.api.kbList()
 assert.equal(after.path,original.path)
 assert.equal(after.name,renamed.name)
 await bridge.api.openSourcePath(original.path)
 assert.deepEqual(reads,[renamed.path])
 assert.deepEqual(opened,[{id,revision}])
})
