import test from 'node:test'
import assert from 'node:assert/strict'
import {randomBytes} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {Readable} from 'node:stream'
import {expect} from '@playwright/test'
import JSZip from 'jszip'
import {PDFDocument} from 'pdf-lib'
import {buildLocalApp} from '../../server/src/app.ts'
import {createGlobalConfigService} from '../../server/src/modules/admin/service.ts'
import {createWorkspaceService} from '../../server/src/modules/workspace/service.ts'
import {createXlsxNativeWorker} from '../../worker/src/native/xlsx.ts'
import {openIsolatedPptxSession} from '../../worker/src/native/pptx-session-host.ts'
import {createCrossPlatformProcess} from '../../worker/src/sandbox/cross-platform-process.ts'
import {launchTestBrowser} from '../helpers/browser.mjs'
import {docxBytes,fileFixture,importFile} from '../helpers/files.mjs'
import {stubHomeHero} from '../helpers/home-hero.mjs'
import {password} from '../helpers/identity.mjs'
import {officeBrowserAsset as dist} from '../helpers/office-browser-assets.mjs'
import {mockProviderNetwork} from '../helpers/provider-network.mjs'
import {sheetsGateway} from '../helpers/sheets-gateway.mjs'

const liveConfig=process.env.DYOFFICE_LIVE_CROSS_FORMAT_KNOWLEDGE_CONFIG

async function markedPackage(fixture,part,pattern,value){
 const zip=await JSZip.loadAsync(await readFile(new URL(fixture,import.meta.url)))
 const content=await zip.file(part).async('string')
 assert.match(content,pattern)
 zip.file(part,content.replace(pattern,value))
 return zip.generateAsync({type:'nodebuffer'})
}

test('Word knowledge opens cited XLSX, PPTX and PDF revisions in their native editors'+(liveConfig?' with a real model':''),{timeout:220000},async t=>{
 const origin='http://127.0.0.1:4296',f=await fileFixture(t,{origin,buildApp:false})
 let app,browser
 t.after(async()=>{await browser?.close();app?.server.closeAllConnections();await app?.close()})
 const keyring={activeKeyId:'cross-format',keys:{'cross-format':new Uint8Array(32).fill(57)}}
 const model=liveConfig?JSON.parse(await readFile(liveConfig,'utf8')).entry:{
  id:'chat',kind:'chat',providerId:'deepseek',label:'Test model',model:'synthetic',
  baseUrl:'https://provider.example/v1',enabled:true,apiKey:'test-key',
 }
 await createGlobalConfigService({transactions:f.transactions,keyring}).saveGlobalConfig(f.adminSigned.token,0,{upserts:[model],defaults:{chat:model.id}})
 await f.preferences.update(f.alice.token,{language:'zh',showAssistant:true,autoSave:false})
 const workspace=createWorkspaceService(f.transactions),batch=randomBytes(4).toString('hex')
 const markers=Object.fromEntries(['xlsx','pptx','pdf'].map(format=>[format,'EVIDENCELINK-'+format.toUpperCase()+'-'+batch]))
 const pdf=await PDFDocument.create()
 pdf.addPage([420,320]).drawText(markers.pdf,{x:28,y:260,size:14})
 const sources=[
  ['xlsx',await markedPackage('../fixtures/sheets/acceptance.xlsx','xl/worksheets/sheet1.xml',/<t>Revenue<\/t>/,'<t>'+markers.xlsx+'</t>')],
  ['pptx',await markedPackage('../fixtures/slides/acceptance.pptx','ppt/slides/slide1.xml',/Acceptance title/,markers.pptx)],
  ['pdf',Buffer.from(await pdf.save())],
 ]
 const draftBytes=await docxBytes(),draft=(await importFile(f,f.alice.token,draftBytes,'查阅记录.docx')).file
 const references=[]
 for(const [format,bytes] of sources){
  const name='来源资料 ('+format.toUpperCase()+').'+format
  const {file}=await importFile(f,f.alice.token,bytes,name)
  await workspace.setStar(f.alice.token,file.fileId,{starred:true})
  const reference=`/files/${file.fileId}/revisions/${file.revision}`
  references.push({format,bytes,name,file,href:'filenav://'+reference,serverPath:reference+'/'+encodeURIComponent(name)})
 }
 if(!liveConfig){
  const ordered=[...references].sort((a,b)=>a.file.fileId.localeCompare(b.file.fileId))
  const toolCall=(name,input,index=0)=>({index,id:'kb-'+name+'-'+index,type:'function',function:{name,arguments:JSON.stringify(input)}})
  let stage=0
  const network=mockProviderNetwork(t,()=>{
   const {messages,tools}=JSON.parse(network.wire.toString())
   const offered=tools.map(tool=>tool.function.name)
   assert.ok(offered.includes('search_knowledge_base')&&offered.includes('read_knowledge_file'))
   const results=messages.filter(message=>message.role==='tool').map(message=>JSON.parse(message.content))
   let delta
   if(stage===0)delta={tool_calls:[toolCall('search_knowledge_base',{query:'EVIDENCELINK'})]}
   else if(stage===1){
    for(const source of references)assert.ok(results[0].output.includes(source.href))
    delta={tool_calls:ordered.map((_source,index)=>toolCall('read_knowledge_file',{index,offset:0},index))}
   }else{
    assert.equal(results.length,4)
    ordered.forEach((source,index)=>assert.ok(results[index+1].output.includes(markers[source.format])))
    delta={content:references.map(source=>`${markers[source.format]} [${source.name}](${source.href})`).join('\n\n')}
   }
   stage++
   return Readable.from([Buffer.from(`data: ${JSON.stringify({choices:[{delta,finish_reason:delta.tool_calls?'tool_calls':'stop'}]})}\n\ndata: [DONE]\n\n`)])
  })
 }
 const gateway=await sheetsGateway(t)
 const manifest=JSON.parse(await readFile(process.env.DYOFFICE_TEST_HOST_MANIFEST??new URL('../../../../.dyoffice-native-build/host-manifest.json',import.meta.url),'utf8'))
 const sheetsNative=createXlsxNativeWorker(createCrossPlatformProcess({deploymentId:f.deploymentId,
  binary:manifest.nativeBinary,sha256:manifest.nativeSha256,
  allowedCommands:['open','read_range','read_formula_cells','read_row_outline','read_media','recalc_cells','save_archive','close'],
 }))
 const slidesHost={openSession(input){
  return openIsolatedPptxSession({fileId:input.fileId,revision:input.revision,bytes:input.bytes},{timeoutMs:60000,unsafeTestOnly:true})
 }}
 app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,
  origin,csrfKey:f.csrfKey,objectStore:f.objects,globalConfigKeyring:keyring,providerGateway:{mode:'shared'},codingHarnesses:false,
  rateLimit:{max:5000,windowMs:60000},nativeDocsDirectory:dist('docs'),nativeSheetsDirectory:dist('sheets'),nativeSlidesDirectory:dist('slides'),nativePdfDirectory:dist('pdf'),localShellDirectory:dist('local-shell'),
  sheetsNative,sheetsPlanner:gateway.planWorkbookSave,sheetsPackageReader:gateway.readWorkbookPackage,slidesHost})
 await app.listen({host:'127.0.0.1',port:4296})
 browser=await launchTestBrowser()
 const page=await browser.newPage({viewport:{width:1440,height:1000}})
 await page.addInitScript(()=>{window.__genofficeDebugHooks=true})
 await stubHomeHero(page)
 await page.goto(origin)
 await page.getByLabel('用户名',{exact:true}).fill('alice')
 await page.getByLabel('密码',{exact:true}).fill(password)
 await page.getByRole('button',{name:'登录',exact:true}).click()
 await expect(page.locator('.home')).toBeVisible()
 await page.goto(origin+'/#/file/'+draft.fileId)
 const word=page.frameLocator(`iframe[data-document-id="${draft.fileId}"]`)
 await expect(word.locator('html')).toHaveAttribute('data-document-loading','ready',{timeout:45000})
 const rail=word.locator('.ai-rail')
 if(await rail.isVisible())await rail.click()
 const composer=word.locator('.ai-panel textarea')
 const reads=new Map()
 page.on('response',response=>{
  const url=new URL(response.url())
  if(response.ok()&&url.pathname==='/api/v1/knowledge/read'){
   const path=url.searchParams.get('path')
   reads.set(path,(reads.get(path)??0)+1)
  }
 })
 await composer.fill('在收藏知识库搜索 EVIDENCELINK，并读取每个命中文档的原文。逐一给出 Excel、PowerPoint 和 PDF 的完整记录编号，每项后用 Markdown 链接引用对应文件，直接复制工具提供的引用链接。')
 await composer.press('Enter')
 const answer=word.locator('.ai-msg-assistant').filter({hasText:'EVIDENCELINK'}).last()
 await expect(answer).toBeVisible({timeout:120000})
 await expect(word.locator('.ai-msg-streaming')).toHaveCount(0,{timeout:60000})
 for(const source of references){
  assert.ok(reads.has(source.serverPath),'read exact '+source.format+' source before answering')
  await expect(answer).toContainText(markers[source.format])
  const link=answer.locator(`a[href="${source.href}"]`)
  await expect(link).toHaveCount(1)
  const citedText=await link.evaluate(anchor=>{
   const reply=anchor.closest('.ai-msg-assistant')
   const links=[...reply.querySelectorAll('a[href^="filenav://"]')]
   const range=anchor.ownerDocument.createRange()
   range.selectNodeContents(reply)
   const previous=links[links.indexOf(anchor)-1]
   if(previous)range.setStartAfter(previous)
   range.setEndAfter(anchor)
   return range.toString()
  })
  assert.deepEqual([...new Set(citedText.match(/EVIDENCELINK-(?:XLSX|PPTX|PDF)-[a-f0-9]{8}/g))],[markers[source.format]])
  const prior=reads.get(source.serverPath)
  await link.click()
  const frame=page.locator(`iframe[data-document-id="${source.file.fileId}"]`)
  await expect(frame).toBeVisible({timeout:45000})
  const editor=frame.contentFrame()
  await expect(editor.locator('html')).toHaveAttribute('data-document-loading','ready',{timeout:45000})
  const url=new URL(await frame.getAttribute('src'),origin)
  assert.equal(url.pathname,`/native-${source.format}/`)
  assert.equal(url.searchParams.get('sourceRevision'),source.file.revision)
  assert.equal(reads.get(source.serverPath),prior+1)
  if(source.format==='xlsx'){
   await expect.poll(()=>editor.locator('html').evaluate(()=>window.__genofficeDebug?.univerAPI.getActiveWorkbook().getActiveSheet().getRange('A1').getValue())).toBe(markers.xlsx)
  }else if(source.format==='pptx'){
   await expect.poll(()=>editor.locator('html').evaluate(async()=>{
    const slides=await window.slidesApi.getRenderSlides()
    return slides[0].nodes.flatMap(node=>node.text?[node.text.lines.map(line=>line.runs.map(run=>run.text).join('')).join('')]:[])
   })).toContain(markers.pptx)
  }else {
   await expect(editor.locator('.textLayer')).toContainText(markers.pdf)
  }
  assert.equal((await f.files.openFile(f.alice.token,source.file.fileId)).file.revision,source.file.revision)
  assert.deepEqual(await f.files.readFile(f.alice.token,source.file.fileId,source.file.revision),source.bytes)
  await page.evaluate(id=>window.aiOfficeTabs.close(id),source.file.fileId)
  await expect(frame).toHaveCount(0)
 }
 const revoked=references.find(source=>source.format==='pdf')
 await workspace.setStar(f.alice.token,revoked.file.fileId,{starred:false})
 await Promise.all([
  page.waitForResponse(response=>{
   const url=new URL(response.url())
   return response.status()===404&&url.pathname==='/api/v1/knowledge/read'&&url.searchParams.get('path')===revoked.serverPath
  }),
  answer.locator(`a[href="${revoked.href}"]`).click(),
 ])
 await expect(word.getByText('引用的来源或版本已失效，请重新检索知识库。',{exact:true})).toBeVisible()
 await expect(page.locator(`iframe[data-document-id="${revoked.file.fileId}"]`)).toHaveCount(0)
 assert.deepEqual(await f.files.readFile(f.alice.token,draft.fileId,draft.revision),draftBytes)
})
