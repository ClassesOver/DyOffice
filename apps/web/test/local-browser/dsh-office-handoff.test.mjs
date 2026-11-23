import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {createServer} from 'node:https'
import {resolve} from 'node:path'
import {officeBrowserAsset as dist} from '../helpers/office-browser-assets.mjs'
import {execFileSync} from 'node:child_process'
import JSZip from 'jszip'
import { XMLParser } from 'fast-xml-parser'
import {PDFDict,PDFDocument,PDFName} from 'pdf-lib'
import {expect} from '@playwright/test'
import {launchTestBrowser,recordVerifiedOfficeEffect} from '../helpers/browser.mjs'
import {fileFixture} from '../helpers/files.mjs'
import {buildLocalApp} from '../../server/src/app.ts'
import {configuredSheetsRuntime} from '../../server/src/modules/sheets/runtime.ts'
import {buildSheetsGateway} from '../../server/sheets/build.mjs'
import {openIsolatedPptxSession} from '../../worker/src/native/pptx-session-host.ts'
import {createCsrfService} from '../../server/src/modules/auth/csrf.ts'

for(const format of ['xlsx','pptx','pdf'])test('DSH writes, saves and follows up in the native '+format+' editor',{timeout:90000},async t=>{
 let app,browser,sheets
 const dir=await mkdtemp(resolve(tmpdir(),'office-handoff-'))
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',dir+'/key','-out',dir+'/cert','-days','1','-subj','/CN=localhost'],{stdio:'ignore'})
 const server=createServer({key:await readFile(dir+'/key'),cert:await readFile(dir+'/cert')},(req,res)=>app.routing(req,res))
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 const origin='https://127.0.0.1:'+server.address().port
 t.after(async()=>{await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await app?.close();await sheets?.close();await rm(dir,{recursive:true,force:true})})
 const f=await fileFixture(t,{origin,buildApp:false})
 if(format==='xlsx'){
  await buildSheetsGateway(resolve(dir,'gateway.mjs'))
  sheets=await configuredSheetsRuntime({DYOFFICE_AUTH_MODE:'local',DYOFFICE_DEPLOYMENT_ID:f.deploymentId,DYOFFICE_XLSX_NODE_ENGINE:resolve(dir,'xlsx-node-engine.mjs'),DYOFFICE_XLSX_GATEWAY_RUNNER:resolve(dir,'gateway-process.mjs'),DYOFFICE_NATIVE_XLSX_DIRECTORY:dist('sheets')},{enabled:true})
 }
 if(format==='pptx'){const before=process.env.NODE_ENV;process.env.NODE_ENV='test';t.after(()=>{if(before===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=before})}
 const slidesHost={openSession(input){return openIsolatedPptxSession(input,{timeoutMs:60000,unsafeTestOnly:true})}}
 app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,assistantChannels:true,...sheets,slidesHost,nativeSlidesDirectory:dist('slides'),nativePdf:true,nativePdfDirectory:dist('pdf'),localShellDirectory:dist('local-shell')})
 await f.preferences.update(f.alice.token,{language:'en',autoSave:false,showAssistant:false})
 const base='/api/v1/assistant-channels',csrf=createCsrfService({db:f.db,deploymentId:f.deploymentId,origin,key:f.csrfKey})
 const post=async(path,payload,headers={cookie:'__Host-dyoffice-session='+f.alice.token,origin,'x-csrf-token':csrf.sessionToken(f.alice.token)})=>{
  const r=await app.inject({method:'POST',url:base+path,headers,payload});assert.equal(r.statusCode,200);return r.json()
 }
 const channel=await post('/channels',{}),member=await post('/channels/'+channel.conversationId+'/dsh-token',{allowCreate:true}),headers={authorization:'Bearer '+member.memberToken}
 const {fileId,baseRevision,previewProof}=await post('/member/documents',{format,title:'Handoff'},headers)
 const {ticket}=await post('/member/documents/'+fileId+'/draft-sync',{origin,write:true},{...headers,'x-dyoffice-document-preview':previewProof})
 browser=await launchTestBrowser()
 const context=await browser.newContext({ignoreHTTPSErrors:true}),page=await context.newPage()
 await context.addCookies([{name:'__Host-dyoffice-session',value:f.alice.token,url:origin+'/',secure:true,httpOnly:true,sameSite:'Strict'}])
 await page.goto(origin)
 await context.route('**/api/v1/ai/catalog',route=>route.fulfill({json:{entries:[{id:'mock',label:'Office'}],defaultId:'mock',
  ...(format==='pdf'?{agents:[{id:'codex',name:'Codex',origin:'builtin',capabilities:['coding']}],defaultAgentId:'codex'}:{})}}))
 const marker='Handoff example',calls=[],toolResults=[]
 const revised='Handoff revised',noteText='Check the revised sentence.',replyText='The original sentence was replaced.'
 const question=format==='pdf'?'Find and revise the original sentence, then add a note and reply.':'What changed?'
 const pdfResults=new Map()
 let pdfStep=0,followupHistory
 await context.route('**/api/v1/ai/turns',async route=>{
  const {request}=route.request().postDataJSON(),last=request.messages.at(-1)
  const event=(type,payload)=>'event: '+type+'\ndata: '+JSON.stringify(payload)+'\n\n'
  // The workspace may ask the model for its own suggestions. Only editor
  // turns should advance the fixture's ordered document tool responses.
  if(request.format!==format)return route.fulfill({contentType:'text/event-stream',body:event('delta',{text:'Office is ready'})+event('done',{})})
  if(last?.role==='tool')toolResults.push(...last.results)
  const following=request.messages.some(m=>m.role==='user'&&m.text.includes(question))
  if(following)followupHistory=request.messages
  let name,input
  if(!calls.length){
   if(format==='xlsx'){name='get_workbook_context';input={}}
   if(format==='pptx'){name='apply_ops';input={ops:[{op:'setNotes',target:{slide:0},text:marker}]}}
   if(format==='pdf'){name='insert_text';input={page:1,text:marker,x:40,y:70,font_size:16,max_width:180}}
  }else if(format==='xlsx'&&calls.length===1){name='read_range';input={range:'A1:A1'}
  }else if(format==='xlsx'&&calls.length===2){
   const sheetId=/id=([^,)]+)/.exec(request.messages.find(m=>m.role==='tool').results[0].output)?.[1]
   name='propose_operations';input={summary:'Write example and calculate a total',operations:[
    {op:'set_cell',sheetId,address:'A1',value:marker},
    {op:'set_cell',sheetId,address:'A2',value:17},
    {op:'set_cell',sheetId,address:'A3',value:25},
    {op:'set_formula',sheetId,address:'B2',formula:'=SUM(A2:A3)'},
   ]}
  }else if(format==='pdf'&&following){
   if(last?.role==='tool')for(const result of last.results)pdfResults.set(result.name,result)
   switch(pdfStep++){
    case 0:name='search_text';input={query:marker};break
    case 1:name='edit_text';input={page:1,old_text:marker,new_text:revised};break
    case 2:name='add_note';input={page:1,x:175,y:70,text:noteText};break
    case 3:{
     const noteId=/Added note (Pd[a-z0-9]+) on page 1/.exec(pdfResults.get('add_note')?.output)?.[1]
     if(noteId){name='reply_note';input={page:1,note_id:noteId,text:replyText}}
     break
    }
   }
  }
  calls.push(request.tools.map(tool=>tool.name))
  await route.fulfill({contentType:'text/event-stream',body:(name?event('tool_call',{id:'call'+calls.length,name,input}):event('delta',{text:'Office replied'}))+event('done',{})})
 })
 const opening=page.waitForEvent('popup')
 await page.evaluate(({origin,fileId,baseRevision,format,ticket})=>{
  const child=window.open(origin+'/native-'+format+'/?fileId='+fileId)
  const writing={id:crypto.randomUUID(),topic:'Create a sample',baseRevision}
  window.addEventListener('message',e=>{if(e.source===child&&e.origin===origin&&e.data?.type==='dsh-dyoffice:draft')window.receipt=e.data})
  setInterval(()=>child.postMessage({type:'dsh-dyoffice:draft-request',fileId,writing,ticket,followup:window.question},origin),150)
 },{format,origin,fileId,baseRevision,ticket})
 const popup=await opening
 await expect.poll(()=>page.evaluate(()=>window.receipt?.writing?.state),{timeout:35000}).toMatch(/^(saved|saveFailed|conflict|noTool|failed)$/)
 const writing=await page.evaluate(()=>window.receipt.writing)
 assert.equal(writing.state,'saved',JSON.stringify({writing,calls,toolResults}))
 assert.deepEqual(await page.evaluate(()=>Object.keys(window.receipt.writing).sort()),['id','reply','revision','state'])
 const {file}=await f.files.openFile(f.alice.token,fileId);assert.notEqual(file.revision,baseRevision)
 const bytes=await f.files.readFile(f.alice.token,fileId,file.revision)
 const content=format==='pdf'?execFileSync('pdftotext',['-','-'],{input:Buffer.from(bytes),encoding:'utf8'}):await (async()=>{const zip=await JSZip.loadAsync(bytes);return (await Promise.all(zip.file(/\.xml$/).map(item=>item.async('string')))).join('')})()
 assert.ok(content.includes(marker))
 if(format==='xlsx'){
  const zip=await JSZip.loadAsync(bytes)
  const xml=await zip.file('xl/worksheets/sheet1.xml').async('string')
  const {worksheet}=new XMLParser({ignoreAttributes:false}).parse(xml)
  const cells=worksheet.sheetData.row.flatMap(row=>row.c)
  const total=cells.find(cell=>cell['@_r']==='B2')
  assert.equal(total?.f,'SUM(A2:A3)')
  assert.equal(total?.v,42)
 }
 if(format==='pptx'){
  const deck=await JSZip.loadAsync(bytes)
  const notes=await deck.file('ppt/notesSlides/notesSlide1.xml').async('string')
  assert.match(notes,/Handoff example/)
  assert.ok(calls.some(tools=>tools.includes('apply_ops')))
  recordVerifiedOfficeEffect('pptx','apply_ops')
 }
 await page.evaluate(question=>{window.question={id:crypto.randomUUID(),question}},question)
 await expect.poll(()=>page.evaluate(()=>window.receipt?.followup?.state),{timeout:15000}).toMatch(/^(ready|failed)$/)
 assert.deepEqual(await page.evaluate(()=>({state:window.receipt.followup.state,answer:window.receipt.followup.answer})),{state:'ready',answer:'Office replied'})
 assert.ok(calls.at(-1).some(n=>['apply_ops','propose_operations','insert_text'].includes(n)))
 assert.ok(followupHistory?.some(m=>m.role==='user'&&m.text.includes('Create a sample')))
 await expect(popup.getByText(question,{exact:true})).toBeVisible()
 await expect(popup.getByText('Office replied',{exact:true}).last()).toBeVisible()
 // A distinct browser profile reads the persisted Office conversation without
 // taking over the editing lease or executing the same assistant turn again.
 await f.preferences.update(f.alice.token,{showAssistant:true})
 const viewer=await browser.newContext({ignoreHTTPSErrors:true})
 if(format==='xlsx')await viewer.addInitScript(()=>{window.__genofficeDebugHooks=true})
 await viewer.addCookies([{name:'__Host-dyoffice-session',value:f.alice.token,url:origin+'/',secure:true,httpOnly:true,sameSite:'Strict'}])
 await viewer.route('**/api/v1/ai/catalog',route=>route.fulfill({json:{entries:[{id:'mock',label:'Office'}],defaultId:'mock'}}))
 let passiveRuns=0
 await viewer.route('**/api/v1/ai/turns',r=>{passiveRuns++;return r.abort()})
 const peer=await viewer.newPage()
 await peer.goto(origin+'/native-'+format+'/?fileId='+fileId)
 if(format==='xlsx'){
   await peer.locator('button.expand-copilot,.ai-chat').first().waitFor()
   const rail=peer.locator('button.expand-copilot')
   if(await rail.isVisible())await rail.click()
   await expect.poll(()=>peer.evaluate(()=>{
    const range=window.__genofficeDebug?.univerAPI?.getActiveWorkbook()?.getActiveSheet()?.getRange('B2')
    return range?{formula:range.getFormula(),value:range.getValue()}:null
   })).toEqual({formula:'=SUM(A2:A3)',value:42})
   recordVerifiedOfficeEffect('xlsx','propose_operations')
 }
 await expect(peer.getByText(question,{exact:true})).toHaveCount(1,{timeout:15000})
 assert.equal(passiveRuns,0)
 if(format==='pdf'){
  assert.ok(calls.at(-1).includes('read_pages'))
  assert.ok(calls.at(-1).includes('read_annotations'))
  assert.ok(calls.every(tools=>!tools.includes('delegate_agent_task')&&!tools.includes('delegate_channel_task')))
  for(const name of ['search_text','edit_text','add_note','reply_note']){
   const result=pdfResults.get(name)
   assert.ok(result&&!result.isError, name+': '+JSON.stringify(result))
  }
  assert.ok(pdfResults.get('search_text').output.includes(marker))
  const {file:saved}=await f.files.openFile(f.alice.token,fileId)
  assert.notEqual(saved.revision,file.revision)
  const editedBytes=await f.files.readFile(f.alice.token,fileId,saved.revision)
  const editedText=execFileSync('pdftotext',['-','-'],{input:Buffer.from(editedBytes),encoding:'utf8'})
  assert.ok(editedText.includes(revised),editedText)
  assert.ok(!editedText.includes(marker),editedText)
  const pdf=await PDFDocument.load(editedBytes),key=PDFName.of
  const notes=pdf.getPage(0).node.Annots().asArray().map(ref=>[ref,pdf.context.lookup(ref,PDFDict)])
   .filter(([,dict])=>String(dict.get(key('Subtype')))==='/Text')
  assert.equal(notes.length,2)
  const [rootRef,root]=notes.find(([,dict])=>!dict.has(key('IRT')))
  const [,reply]=notes.find(([,dict])=>dict.has(key('IRT')))
  assert.equal(root.lookup(key('Contents')).decodeText(),noteText)
  assert.equal(reply.lookup(key('Contents')).decodeText(),replyText)
  assert.equal(String(reply.get(key('IRT'))),String(rootRef))
  assert.deepEqual(await f.files.readFile(f.alice.token,fileId,file.revision),bytes)
 }
})
