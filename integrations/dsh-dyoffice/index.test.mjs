import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {mkdtemp,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {apply,inject,parseDyOfficeCommand} from './index.js'

test('registers /dyoffice as an input command for the supported Office formats',async()=>{
  const commands=[]
  apply({
    inject(){},
    commands:{register(definition){commands.push(definition)}},
  },{})
  assert.deepEqual(inject,['commands','llm','skills','workingDirectory','tools'])
  const command=commands.find(value=>value.name==='dyoffice')
  assert.ok(command)
  assert.equal(command.input.hint,'<word|xlsx|pptx|pdf> <instruction>')
  assert.match(command.description,/Word.*XLSX.*PPTX.*PDF/)
  assert.deepEqual(await command.handler({rawInput:'  ',signal:new AbortController().signal,agent:{}}),{
    kind:'success',text:'用法：/dyoffice <word|xlsx|pptx|pdf> <任务>\n生成 Word：/dyoffice word 创建一个活动策划\n使用 DSH Skill：/dyoffice word --skill=名称 创建活动策划\n创建空白文件：/dyoffice word 创建空白文件 demo\n分析当前频道文档：/dyoffice word 总结当前文档',
  })
})

test('parses the four /dyoffice format subcommands',()=>{
  assert.deepEqual(parseDyOfficeCommand('word Summarize this document'),{format:'word',instruction:'Summarize this document'})
  assert.deepEqual(parseDyOfficeCommand('xlsx 汇总预算'),{format:'xlsx',instruction:'汇总预算'})
  assert.deepEqual(parseDyOfficeCommand('pptx 列出主要结论'),{format:'pptx',instruction:'列出主要结论'})
  assert.deepEqual(parseDyOfficeCommand('pdf 提取合同金额'),{format:'pdf',instruction:'提取合同金额'})
  assert.equal(parseDyOfficeCommand('csv 汇总数据'),null)
  assert.deepEqual(parseDyOfficeCommand('word 创建空白文件 demo'),{format:'word',title:'demo'})
  assert.deepEqual(parseDyOfficeCommand('word 创建一个活动策划'),{format:'word',title:'活动策划',writing:'活动策划'})
  for (const format of ['xlsx','pptx','pdf']) {
    assert.deepEqual(parseDyOfficeCommand(format+' create Budget.'+format),{format,title:'Budget.'+format,writing:'Budget'})
    assert.deepEqual(parseDyOfficeCommand(format+' create blank Budget'),{format,title:'Budget'})
  }
})

test('extracts a selected DSH skill without including its name in the document title',()=>{
  assert.deepEqual(parseDyOfficeCommand('word --skill=events 创建活动策划'),
    {format:'word',skill:'events',title:'活动策划',writing:'活动策划'})
})

test('the Word create command returns the link to the new document',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'dsh-create-'))
  t.after(()=>rm(directory,{recursive:true,force:true}))
  const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const proof='d'.repeat(64)
  const server=createServer(async(request,response)=>{
    if(request.method==='GET'){
      if(request.url.endsWith('/preview')){
        if(request.headers['x-dyoffice-document-preview']!==proof)return response.writeHead(403).end()
        return response.end(JSON.stringify({fileId:id,revision:id,text:'Test'}))
      }
      response.end(JSON.stringify({conversationId:id,member:{membershipId:id},canCreate:true,fileId:id}))
      return
    }
    const chunks=[]
    for await(const chunk of request)chunks.push(chunk)
    const input=JSON.parse(Buffer.concat(chunks))
    if(request.url!=='/api/v1/assistant-channels/member/documents'||input.format!=='docx'||input.title!=='demo'){
      response.writeHead(400).end()
      return
    }
    response.end(JSON.stringify({fileId:id,name:'demo.docx',previewProof:proof}))
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  t.after(()=>new Promise(resolve=>server.close(resolve)))
  const origin='http://127.0.0.1:'+server.address().port
  const memberFile=join(directory,'token.json')
  await writeFile(memberFile,JSON.stringify({origin,token:'example-token'}))
  let command, tool
  apply({inject(){},tools:{register(value){tool=value}},commands:{register(value){command=value}}},{memberFile})
  assert.equal(tool?.name,'dyoffice_document')
  const current=await tool.execute({action:'open'},{signal:t.signal})
  assert.equal(current.url,origin+'/#/file/'+id)
  const opened=await tool.execute({action:'create',format:'docx',title:'demo'},{signal:t.signal})
  assert.deepEqual(opened,{fileId:id,name:'demo.docx',url:origin+'/#/file/'+id})
  const result=await command.handler({rawInput:'word 创建空白文件 demo',signal:new AbortController().signal})
  assert.deepEqual(result,{kind:'success',text:'已创建 demo.docx\n'+origin+'/#/file/'+id})
  let handler
  apply({
    inject(_,register){register({effect:run=>run(),webServer:{register(value){handler=value.handler}}})},
    commands:{register(){}},
  },{memberFile})
  const payload=await new Promise((resolve,reject)=>{
    handler({method:'GET',url:'/?file='+id,headers:{}},
      {once(){},writeHead(){},end(value){resolve(JSON.parse(value))}},{principal:{kind:'owner'}}).catch(reject)
  })
  assert.equal(payload.preview.fileId,id)
  assert.equal(payload.preview.revision,id)
  assert.ok(!JSON.stringify(payload).includes(proof))
})

test('Word review uses the selected DSH model only for the confirmed saved revision',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'dsh-write-'))
  t.after(()=>rm(directory,{recursive:true,force:true}))
  const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const proof='a'.repeat(64)
  const office=createServer((request,response)=>{
    let body
    if(request.url.endsWith('/member')) body={conversationId:id,member:{membershipId:id},canCreate:true,fileId:null}
    else if(request.url.endsWith('/member/documents')) body={fileId:id,name:'活动策划.docx',previewProof:proof}
    else if(request.url.endsWith('/preview')) body={fileId:id,name:'活动策划.docx',revision:id,text:'DyOffice 写好的活动策划'}
    else return response.writeHead(404).end()
    response.end(JSON.stringify(body))
  })
  await new Promise(resolve=>office.listen(0,'127.0.0.1',resolve))
  t.after(()=>new Promise(resolve=>office.close(resolve)))
  const origin='http://127.0.0.1:'+office.address().port
  const memberFile=join(directory,'token.json')
  await writeFile(memberFile,JSON.stringify({origin,token:'example-token'}))
  let command, handler, streamRequest, first, finish
  const selectedSkills=[]
  const started=new Promise(resolve=>{first=resolve})
  const completing=new Promise(resolve=>{finish=resolve})
  const model={provider:'example',model:'test'}
  apply({
    inject(_keys,callback){callback({effect(run){run()},webServer:{register(value){handler=value.handler}}})},
    tools:{register(){}},skills:{async get(name){selectedSkills.push(name);return {content:'Include the event owner.'}}},
    commands:{register(value){command=value}},
    llm:{async *stream(request){
      streamRequest=request
      yield {type:'text-delta',index:0,text:'补充活动负责人'}
      first()
      await completing
      yield {type:'finish',reason:{kind:'stop'}}
    }},
  },{memberFile})
  async function request(method,url) {
    return new Promise((resolve,reject)=>{
      const response={once(){},writeHead(status){this.status=status},end(value){resolve({status:this.status,body:JSON.parse(value)})}}
      handler({method,url,headers:{'x-dyoffice-draft':'1','sec-fetch-site':'same-origin'}},response,{principal:{kind:'owner'}}).catch(reject)
    })
  }
  const preview=async()=>(await request('GET','/?file='+id)).body.writing
  const result=await command.handler({
    rawInput:'word --skill=events 创建一个活动策划',signal:new AbortController().signal,
    agent:{model:{current:()=>model}},
  })
  assert.match(result.text,/已创建 活动策划\.docx/)
  const writing=await preview()
  assert.equal(writing.topic,'活动策划')
  assert.deepEqual(selectedSkills,['events'])
  assert.deepEqual(writing.skill,{name:'events',content:'Include the event owner.'})
  assert.equal(streamRequest,undefined)
  assert.equal((await request('POST','/?review='+id+'&job='+id+'&revision='+id)).status,403)
  const reviewUrl='/?review='+id+'&job='+writing.id+'&revision='+id
  assert.equal((await request('POST',reviewUrl)).status,200)
  await started
  try {
    assert.equal(streamRequest.provider,model.provider)
    assert.equal(streamRequest.model,model.model)
    assert.deepEqual(JSON.parse(streamRequest.messages[0].content[0].text),{topic:'活动策划',draft:'DyOffice 写好的活动策划'})
    assert.deepEqual((await preview()).review,{state:'reviewing'})
    assert.equal((await request('POST',reviewUrl)).status,200)
  } finally {finish()}
  assert.deepEqual((await preview()).review,{state:'ready',text:'补充活动负责人'})
})

test('natural language saves a filled Word document and only an owner navigation requests an edit ticket',async t=>{
 const fileId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
 const createdId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
 const ticket='x'.repeat(43),proof='d'.repeat(64),requests=[],documents=[]
 let linkedFile=fileId
 const directory=await mkdtemp(join(tmpdir(),'dsh-guest-'))
 t.after(()=>rm(directory,{recursive:true,force:true}))
 const server=createServer(async(request,response)=>{
  assert.equal(request.headers.authorization,'Bearer sample-token')
  if(request.method==='GET')return response.end(JSON.stringify({conversationId:fileId,member:{membershipId:fileId},fileId:linkedFile,canEdit:true}))
  if(request.url.endsWith('/member/documents')){
   const chunks=[]
   for await(const chunk of request)chunks.push(chunk)
   documents.push(JSON.parse(Buffer.concat(chunks)))
   return response.end(JSON.stringify({fileId:createdId,name:'demo.docx',previewProof:proof}))
  }
  requests.push([request.url,request.headers['x-dyoffice-document-preview']])
  response.end(JSON.stringify({ticket}))
 })
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 t.after(()=>new Promise(resolve=>server.close(resolve)))
 const origin='http://127.0.0.1:'+server.address().port,memberFile=join(directory,'token.json')
 await writeFile(memberFile,JSON.stringify({origin,token:'sample-token'}))
 let tool,handler
 const ctx={get:()=>({getAdvertisedUrl:()=>origin+'/web/'}),commands:{register(){}},tools:{register:value=>{tool=value}},
  inject:(_keys,callback)=>callback({effect:run=>run(),webServer:{register:value=>{handler=value.handler}}})}
 apply(ctx,{memberFile})
 const opened=await tool.execute({action:'open'},{signal:t.signal})
 const created=await tool.execute({action:'create',format:'docx',title:'demo'},{signal:t.signal})
 assert.equal(opened.url,origin+'/web/dyoffice-preview?edit='+fileId)
 assert.equal(created.url,origin+'/web/dyoffice-preview?edit='+createdId)
 const text='活动安排\n周五下午举行活动。'
 const written=await tool.execute({action:'create',format:'docx',title:'demo',body:text},{signal:t.signal})
 assert.equal(written.url,created.url)
 assert.deepEqual(documents,[{format:'docx',title:'demo'},{format:'docx',title:'demo',body:text}])
 await assert.rejects(tool.execute({action:'create',format:'pdf',title:'demo',body:text},{signal:t.signal}),/正文/)
 linkedFile=null
 apply(ctx,{memberFile})
 assert.equal((await tool.execute({action:'open_recent'},{signal:t.signal})).url,created.url)
 assert.deepEqual(requests,[])
 const navigate=async(url,kind,site,destination='document')=>new Promise((resolve,reject)=>{
  const response={writeHead(status,headers){this.result={status,headers}},end(body){resolve({...this.result,body})}}
  handler({method:'GET',url,headers:{'sec-fetch-site':site,'sec-fetch-mode':'navigate','sec-fetch-dest':destination}},response,{principal:{kind}}).catch(reject)
 })
 assert.equal((await navigate(created.url,'guest','same-origin')).status,403)
 assert.equal((await navigate(created.url,'owner','cross-site')).status,403)
 assert.equal((await navigate(opened.url,'owner','same-origin')).status,403)
 for(const [site,destination] of [['same-origin','iframe'],['none','document']]){
  const landing=await navigate(created.url,'owner',site,destination)
  assert.equal(landing.status,200)
  assert.match(landing.headers['Content-Type'],/^text\/html/)
  assert.ok(landing.body.includes('href="?edit='+createdId+'" target="_blank"'))
 }
 assert.deepEqual(requests,[])
 const redirect=await navigate(created.url,'owner','same-origin')
 assert.equal(redirect.status,303)
 assert.equal(redirect.headers.Location,origin+'/dsh-edit#'+ticket)
 assert.deepEqual(requests,[[`/api/v1/assistant-channels/member/documents/${createdId}/edit-ticket`,proof]])

 // A client without a published DSH web URL must still receive its saved document.
 apply({...ctx,get:()=>undefined},{memberFile})
 const count=documents.length
 const standalone=await tool.execute({action:'create',format:'docx',title:'standalone',body:text},{signal:t.signal})
 assert.deepEqual(standalone,{fileId:createdId,name:'demo.docx',url:origin+'/#/file/'+createdId})
 assert.deepEqual(documents.slice(count),[{format:'docx',title:'standalone',body:text}])
})
