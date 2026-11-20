import test from 'node:test'
import assert from 'node:assert/strict'
import {createWebAttachments} from '../../src/editors/web-attachments.ts'

test('Web attachments parse text through GenOffice and provide the same paged read contract',async()=>{
 const requests=[]
 const client=createWebAttachments(async(path,method,body)=>{
  requests.push({path,method,body})
  const text=await body.text()
  return {ok:true,kind:'text',text,totalChars:text.length,truncated:false}
 })
 const path=client.getPathForFile(new File(['attachment body'],'notes.txt'))
 const added=await client.addAttachmentPaths([path])
 assert.equal(added.accepted[0].name,'notes.txt')
 assert.match(requests[0].path,/ai\/attachments\/parse\?name=notes.txt$/)
 assert.equal(requests[0].method,'POST')
 assert.deepEqual(await client.readAttachment(path,4,5),{ok:true,name:'notes.txt',totalChars:15,offset:4,text:'chmen'})
 client.dispose()
 assert.equal((await client.readAttachment(path)).ok,false)
})

test('Web image attachments remain local and return the native multimodal image shape',async()=>{
 const client=createWebAttachments(async()=>{throw new Error('image bytes must not upload for parsing')})
 const path=client.getPathForFile(new File([Uint8Array.from([0x89,0x50,0x4e,0x47])],'chart.png',{type:'image/png'}))
 const added=await client.addAttachmentPaths([path])
 assert.equal(added.accepted[0].ext,'png')
 assert.deepEqual(await client.readAttachmentImage(path),{ok:true,base64:'iVBORw==',mime:'image/png'})
 client.dispose()
})

test('Web attachments reject text truncated by the server parser',async()=>{
 const client=createWebAttachments(async()=>({ok:true,kind:'text',text:'partial',truncated:true}))
 const path=client.getPathForFile(new File(['full source'],'large.txt'))
 const result=await client.addAttachmentPaths([path])
 assert.deepEqual(result,{accepted:[],rejected:['large.txt: extracted text exceeds the Web attachment limit.']})
})


test('truncated XLSX retains the original file for merge without claiming complete extracted text',async()=>{
 const file=new File(['full workbook bytes'],'large.XLSX')
 const client=createWebAttachments(async()=>({ok:true,kind:'text',text:'partial',truncated:true}))
 const path=client.getPathForFile(file)
 assert.deepEqual(await client.addAttachmentPaths([path]),{accepted:[{path,name:file.name,ext:'xlsx',sizeBytes:file.size}],rejected:[]})
 assert.equal(await client.getFileForPath(path),file)
 const read=await client.readAttachment(path)
 assert.equal(read.ok,false)
 assert.equal(read.truncated,true)
 assert.match(read.error,/partial.*text.*original.*merge/i)
})

test('outside Excel only XLSX is retained on truncation, with parse and upload limits intact',async()=>{
 for(const name of ['book.xls','book.xlsm','report.docx','report.pdf']){
  const client=createWebAttachments(async()=>({ok:true,kind:'text',text:'partial',truncated:true}))
  const path=client.getPathForFile(new File(['data'],name))
  assert.equal((await client.addAttachmentPaths([path])).accepted.length,0)
  assert.equal(await client.getFileForPath(path),null)
 }
 for(const result of [{ok:false,kind:'unsupported',error:'Unauthorized'},{ok:true,kind:'image',truncated:true}]){
  const client=createWebAttachments(async()=>result)
  const path=client.getPathForFile(new File(['data'],'book.xlsx'))
  assert.equal((await client.addAttachmentPaths([path])).accepted.length,0)
  assert.equal(await client.getFileForPath(path),null)
 }
 let requests=0
 const client=createWebAttachments(async()=>{requests++;throw new Error('must not parse')})
 for(const file of [new File(['x'],'book.exe'),new File([],'empty.xlsx'),new File([new Uint8Array(50*1024*1024+1)],'large.xlsx')]){
  const path=client.getPathForFile(file)
  assert.equal((await client.addAttachmentPaths([path])).accepted.length,0)
  assert.equal(await client.getFileForPath(path),null)
 }
 assert.equal(requests,0)
 const denied=createWebAttachments(async()=>{throw new Error('Unauthorized')})
 const path=denied.getPathForFile(new File(['x'],'book.xlsx'))
 assert.deepEqual(await denied.addAttachmentPaths([path]),{accepted:[],rejected:['Unauthorized']})
 assert.equal(await denied.getFileForPath(path),null)
})

test('Excel retains every supported merge input when its text preview is truncated',async()=>{
 const client=createWebAttachments(async()=>({ok:true,kind:'text',text:'partial',truncated:true}),'xlsx')
 const files=['xlsx','xlsm','xls','csv','tsv'].map(ext=>new File(['full source'],'large.'+ext))
 const paths=files.map(file=>client.getPathForFile(file))
 const {accepted,rejected}=await client.addAttachmentPaths(paths)
 assert.deepEqual(rejected,[])
 assert.deepEqual(accepted.map(item=>item.name),files.map(file=>file.name))
 for(const [index,path] of paths.entries()){
  assert.equal(await client.getFileForPath(path),files[index])
  assert.equal((await client.readAttachment(path)).truncated,true)
 }
})
