import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {execFileSync} from 'node:child_process'
import {createServer} from 'node:https'
import {randomUUID} from 'node:crypto'
import {expect} from '@playwright/test'
import JSZip from 'jszip'
import {launchTestBrowser} from '../helpers/browser.mjs'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {password} from '../helpers/identity.mjs'
import {officeBrowserAsset} from '../helpers/office-browser-assets.mjs'
import {buildLocalApp} from '../../server/src/app.ts'

async function fixture(t,{embed=false,wordCollaboration=false}={}){
 const directory=await mkdtemp(join(tmpdir(),'dyoffice-docx-create-'))
 let app,server,parentServer,browser
 t.after(async()=>{
  await browser?.close()
  if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
  if(parentServer){parentServer.closeAllConnections();await new Promise(resolve=>parentServer.close(resolve))}
  await app?.close();await rm(directory,{recursive:true,force:true})
 })
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(directory,'key.pem'),'-out',join(directory,'cert.pem'),'-days','1','-subj','/CN=localhost'],{stdio:'pipe'})
 const tls={key:await readFile(join(directory,'key.pem')),cert:await readFile(join(directory,'cert.pem'))}
 server=createServer(tls,(req,res)=>app.routing(req,res))
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 const origin=`https://127.0.0.1:${server.address().port}`
 let dshEditorOrigin
 if(embed){
  parentServer=createServer(tls,(_req,res)=>res.setHeader('Content-Type','text/html').end('<iframe title="DyOffice" style="width:100%;height:90vh"></iframe>'))
  await new Promise(resolve=>parentServer.listen(0,'127.0.0.1',resolve))
  dshEditorOrigin=`https://127.0.0.1:${parentServer.address().port}`
 }
 const f=await fileFixture(t,{origin,buildApp:false})
 await f.preferences.update(f.alice.token,{language:'en',autoSave:false,showAssistant:false})
 app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,nativeDocsDirectory:process.env.DYOFFICE_TEST_NATIVE_DOCS_DIRECTORY??officeBrowserAsset('docs'),localShellDirectory:officeBrowserAsset('local-shell'),dshEditorOrigin,assistantChannels:embed,wordCollaboration})
 browser=await launchTestBrowser()
 const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1440,height:1100}}),page=await context.newPage()
 const challenge=await (await context.request.get(origin+'/api/v1/auth/csrf')).json()
 assert.equal((await context.request.post(origin+'/api/v1/auth/login',{headers:{origin,'x-csrf-token':challenge.csrfToken},data:{username:'alice',password}})).status(),200)
 await page.goto(origin)
 await expect(page.locator('.home')).toBeVisible()
 await page.waitForFunction(()=>typeof window.dyofficeCreateAiDoc==='function')
 return {...f,origin,page,context,dshEditorOrigin}
}

test('a trusted DSH page can edit and save Word in the DyOffice frame',{timeout:70_000},async t=>{
 const f=await fixture(t,{embed:true})
 const api=f.origin+'/api/v1/assistant-channels'
 const challenge=await (await f.context.request.get(f.origin+'/api/v1/auth/csrf')).json()
 const headers={origin:f.origin,'x-csrf-token':challenge.csrfToken}
 const createdChannel=await f.context.request.post(api+'/channels',{headers,data:{conversationId:randomUUID()}})
 assert.equal(createdChannel.status(),200)
 const {conversationId}=await createdChannel.json()
 const {memberToken}=await (await f.context.request.post(api+'/channels/'+conversationId+'/dsh-token',{headers,data:{allowCreate:true}})).json()
 const member={authorization:'Bearer '+memberToken}
 // Bearer calls use an isolated request context so they never carry owner cookies.
 const apiRequest=await (await import('@playwright/test')).request.newContext({ignoreHTTPSErrors:true})
 t.after(()=>apiRequest.dispose())
 const created=await apiRequest.post(api+'/member/documents',{headers:member,data:{format:'docx',title:'Embedded editor check'}})
 assert.equal(created.status(),200)
 const {fileId,previewProof}=await created.json()
 const ticketResponse=await apiRequest.post(api+'/member/documents/'+fileId+'/draft-sync',{
  headers:{...member,'x-dyoffice-document-preview':previewProof},data:{origin:f.dshEditorOrigin},
 })
 assert.equal(ticketResponse.status(),200)
 const {ticket}=await ticketResponse.json()
 const parent=await f.context.newPage()
 await parent.goto(f.dshEditorOrigin)
 await parent.locator('iframe').evaluate((frame,url)=>frame.src=url,f.origin+'/?dshEmbed=1#/file/'+fileId)
 const editor=parent.frameLocator('iframe').frameLocator('iframe[data-document-id="'+fileId+'"]')
 const page=editor.locator('.tiptap.doc-page[contenteditable="true"]').first()
 await expect(page).toBeVisible({timeout:20_000})
 const text='Edited from the DSH sidebar'
 await page.click()
 await parent.keyboard.insertText(text)
 await expect(page).toContainText(text)
 const sent=await parent.evaluate(({origin,fileId,ticket})=>new Promise(resolve=>{
  const target=document.querySelector('iframe').contentWindow
  const receive=event=>{
   if(event.origin!==origin||event.source?.parent!==target||event.data?.fileId!==fileId||event.data?.type!=='dsh-dyoffice:draft')return
   finish(event.data.draft?.text)
  }
  const finish=value=>{clearInterval(timer);clearTimeout(timeout);removeEventListener('message',receive);resolve(value)}
  const timer=setInterval(()=>target.postMessage({type:'dsh-dyoffice:draft-request',fileId,ticket},origin),200)
  const timeout=setTimeout(()=>finish(null),8000)
  addEventListener('message',receive)
 }),{origin:f.origin,fileId,ticket})
 assert.match(sent,new RegExp(text))
 const committed=parent.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/commits')&&r.ok())
 await parent.keyboard.press('Control+s')
 await committed
 const saved=await f.files.openFile(f.alice.token,fileId)
 const zip=await JSZip.loadAsync(await f.files.readFile(f.alice.token,fileId,saved.file.revision))
 assert.match(await zip.file('word/document.xml').async('string'),new RegExp(text))
})

test('real shell DOCX creation waits for saved body; native bridge rejects a failed save and reopening reads the persisted body',{timeout:120_000},async t=>{
 const f=await fixture(t),errors=[]
 f.page.on('pageerror',error=>errors.push(error.message))
 const reached=Promise.withResolvers(),resume=Promise.withResolvers()
 t.after(()=>resume.resolve())
 let fileId
 let commitResponse
 await f.page.route('**/api/v1/files/*/commits',async route=>{
  fileId=route.request().postDataJSON().fileId
  const response=await route.fetch()
  commitResponse=response
  reached.resolve();await resume.promise;await route.fulfill({response})
 },{times:1})
 await f.page.evaluate(()=>{
  window.creationOutcome={status:'pending'}
  void window.dyofficeCreateAiDoc({type:'docx',title:'Created report',content:'<h1>Quarterly report</h1><p>Browser persisted generated body 2026</p>'}).then(()=>{window.creationOutcome={status:'succeeded'}},error=>{window.creationOutcome={status:'failed',error:error.message}})
 })
 await Promise.race([reached.promise,f.page.waitForFunction(()=>window.creationOutcome?.status!=='pending',undefined,{timeout:30_000}).then(async()=>{
  assert.fail(`DOCX creation completed before its commit: ${JSON.stringify(await f.page.evaluate(()=>window.creationOutcome))}`)
 })])
 assert.equal(commitResponse.status(),200,await commitResponse.text())
 assert.equal(await f.page.evaluate(()=>window.creationOutcome.status),'pending','Opening the iframe or a held HTTP commit must not report success')
 const committed=await f.files.openFile(f.alice.token,fileId)
 const zip=await JSZip.loadAsync(await f.files.readFile(f.alice.token,fileId,committed.file.revision))
 assert.match(await zip.file('word/document.xml').async('string'),/Browser persisted generated body 2026/)
 resume.resolve()
 await expect.poll(()=>f.page.evaluate(()=>window.creationOutcome.status),{timeout:45_000}).toBe('succeeded')
 const frame=f.page.frameLocator(`iframe[data-document-id="${fileId}"]`)
 await expect(frame.locator('.dyoffice-docs-persistence-state')).toHaveAttribute('data-native-save','accepted')
 await expect(frame.locator('.dyoffice-docs-persistence-state')).toHaveAttribute('data-dirty','false')
 await expect(frame.locator('.tiptap.doc-page').first()).toContainText('Browser persisted generated body 2026')

 let rejectedFileId
 await f.page.route('**/api/v1/files/*/commits',async route=>{
  rejectedFileId=route.request().postDataJSON().fileId
  await route.fulfill({status:409,contentType:'application/problem+json',body:JSON.stringify({type:'about:blank',title:'Conflict',status:409})})
 },{times:1})
 const result=await frame.locator('body').evaluate(()=>window.desktop.createDocument({type:'docx',title:'Rejected report',content:'<p>Must not be acknowledged as saved</p>'}))
 assert.equal(result.ok,false)
 assert.match(result.error,/未确认保存/)
 assert.ok(rejectedFileId)
 const rejected=await f.files.openFile(f.alice.token,rejectedFileId)
 const rejectedZip=await JSZip.loadAsync(await f.files.readFile(f.alice.token,rejectedFileId,rejected.file.revision))
 assert.doesNotMatch(await rejectedZip.file('word/document.xml').async('string'),/Must not be acknowledged as saved/)

 const reopened=await f.context.newPage()
 await reopened.goto(f.origin+'/native-docx/?fileId='+fileId)
 await expect(reopened.locator('.tiptap.doc-page').first()).toContainText('Browser persisted generated body 2026',{timeout:45_000})
 assert.deepEqual(errors,[])
})


test('two independently logged-in browsers merge concurrent Word input and persist it on reopen',{timeout:90_000},async t=>{
 const f=await fixture(t,{wordCollaboration:true})
 const {file:{fileId}}=await importFile(f,f.alice.token,await readFile(new URL('../../../../fixtures/generated/kitchen-sink.docx',import.meta.url)),'Concurrent.docx')
 const otherBrowser=await launchTestBrowser()
 t.after(()=>otherBrowser.close())
 const second=await otherBrowser.newContext({ignoreHTTPSErrors:true})
 const csrf=await (await second.request.get(f.origin+'/api/v1/auth/csrf')).json()
 assert.equal((await second.request.post(f.origin+'/api/v1/auth/login',{headers:{origin:f.origin,'x-csrf-token':csrf.csrfToken},data:{username:'alice',password}})).status(),200)
 const other=await second.newPage(),url=f.origin+'/native-docx/?fileId='+fileId
 const editable=page=>page.locator('.tiptap.doc-page[contenteditable="true"]').first()
 await f.page.goto(url)
 await expect(editable(f.page)).toBeVisible()
 await other.goto(url)
 await expect(editable(other)).toBeVisible({timeout:12_000})
 // Hold the first append from each editor so both work on the same base.
 const release=Promise.withResolvers(),versions=[]
 t.after(()=>release.resolve())
 for(const page of [f.page,other]){
   let first=true
   await page.route('**/files/*/word-collab',async route=>{
     const body=route.request().postDataJSON()
     if(first&&body.steps?.length){
       first=false;versions.push(body.version)
       await release.promise
     }
     await route.continue()
   })
 }
 for(const page of [f.page,other]){
   await editable(page).click()
   await page.keyboard.press('Control+Home')
 }
 await Promise.all([f.page.keyboard.insertText('FirstBrowserMarker'),other.keyboard.insertText('SecondBrowserMarker')])
 try{
   await expect.poll(()=>versions.length,{timeout:8000}).toBe(2)
   assert.equal(versions[0],versions[1])
 }finally{release.resolve()}
 for(const page of [f.page,other])for(const marker of ['FirstBrowserMarker','SecondBrowserMarker'])
   await expect(editable(page)).toContainText(marker,{timeout:12_000})
 const merged=await editable(f.page).innerText()
 assert.equal(await editable(other).innerText(),merged)
 await f.page.keyboard.press('Control+s')
 await expect.poll(async()=>{
   const head=await f.files.openFile(f.alice.token,fileId)
   const zip=await JSZip.loadAsync(await f.files.readFile(f.alice.token,fileId,head.file.revision))
   const body=await zip.file('word/document.xml').async('string')
   return ['FirstBrowserMarker','SecondBrowserMarker'].every(s=>body.includes(s))
 },{timeout:15_000}).toBe(true)
 await other.reload()
 await expect(other.locator('.tiptap.doc-page').first()).toHaveText(merged,{useInnerText:true,timeout:12_000})
 // A co-editor already on the saved base can take over persistence without
 // stealing the first browser's lease or losing edits after it closes.
 await expect(editable(other)).toBeVisible()
 await expect.poll(()=>f.page.evaluate(()=>window.dyofficeEditorDispose()),{timeout:10000}).toBe(true)
 await f.page.close()
 await editable(other).click()
 await other.keyboard.press('Control+Home')
 await other.keyboard.insertText('RemainingBrowserMarker')
 await expect.poll(async()=>{
   const head=await f.files.openFile(f.alice.token,fileId)
   const zip=await JSZip.loadAsync(await f.files.readFile(f.alice.token,fileId,head.file.revision))
   const body=await zip.file('word/document.xml').async('string')
   return ['FirstBrowserMarker','SecondBrowserMarker','RemainingBrowserMarker'].every(marker=>body.includes(marker))
 },{timeout:20_000}).toBe(true)
})

test('Word assistant streams to another browser without a second run and resumes the thread after reload',{timeout:90_000},async t=>{
 const f=await fixture(t)
 await f.preferences.update(f.alice.token,{showAssistant:true})
 const {file:{fileId}}=await importFile(f,f.alice.token,await readFile(new URL('../../../../fixtures/generated/kitchen-sink.docx',import.meta.url)),'Shared chat.docx')
 const peer=await launchTestBrowser()
 t.after(()=>peer.close())
 const context=await peer.newContext({ignoreHTTPSErrors:true}),other=await context.newPage()
 const csrf=await (await context.request.get(f.origin+'/api/v1/auth/csrf')).json()
 assert.equal((await context.request.post(f.origin+'/api/v1/auth/login',{headers:{origin:f.origin,'x-csrf-token':csrf.csrfToken},data:{username:'alice',password}})).status(),200)
 const url=f.origin+'/native-docx/?fileId='+fileId
 for(const page of [f.page,other]){
   await page.route('**/api/v1/ai/catalog',r=>r.fulfill({json:{entries:[{id:'office-model',label:'Office model'}],defaultId:'office-model'}}))
   await page.addInitScript(()=>{
     const fetch=window.fetch.bind(window)
     window.receivedTurns=[]
     window.fetch=(path,init)=>{
       if(path!=='/api/v1/ai/turns'||init?.method!=='POST')return fetch(path,init)
       window.receivedTurns.push(JSON.parse(init.body).request.messages)
       const frame=(type,data)=>new TextEncoder().encode('event: '+type+'\ndata: '+JSON.stringify(data)+'\n\n')
       return Promise.resolve(new Response(new ReadableStream({start(controller){
         controller.enqueue(frame('delta',{text:'Live reply marker'}))
         window.finishChat=()=>{controller.enqueue(frame('delta',{text:' completed.'}));controller.enqueue(frame('done',{}));controller.close()}
       }}),{headers:{'Content-Type':'text/event-stream'}}))
     }
   })
 }
 const open=async page=>{
   await page.goto(url)
   await expect(page.locator('.tiptap.doc-page').first()).toBeVisible()
   if(await page.locator('.ai-rail').isVisible())await page.locator('.ai-rail').click()
   await expect(page.locator('.ai-panel textarea')).toBeVisible()
 }
 await open(f.page);await open(other)
 const ask=async(page,text)=>{const input=page.locator('.ai-panel textarea');await input.fill(text);await input.press('Enter')}
 await ask(f.page,'First browser question')
 const chat=other.locator('.ai-panel .ai-chat')
 await expect(chat.getByText('First browser question',{exact:true})).toHaveCount(1,{timeout:12000})
 await expect(chat.getByText('Live reply marker',{exact:true})).toBeVisible()
 assert.equal(await other.evaluate(()=>window.receivedTurns.length),0)
 await f.page.evaluate(()=>window.finishChat())
 await expect(chat.getByText('Live reply marker completed.',{exact:true})).toHaveCount(1)
 await open(other)
 await expect(chat.getByText('Live reply marker completed.',{exact:true})).toBeVisible()
 await ask(other,'Second browser follow-up')
 await expect.poll(()=>other.evaluate(()=>window.receivedTurns.length)).toBe(1)
 const roles=await other.evaluate(()=>window.receivedTurns[0].map(m=>[m.role,m.text]))
 assert.ok(roles.some(([r,v])=>r==='user'&&v?.includes('First browser question')))
 assert.ok(roles.some(([r,v])=>r==='assistant'&&v?.includes('Live reply marker completed.')))
 await other.evaluate(()=>window.finishChat())
 await expect(f.page.locator('.ai-chat').getByText('Second browser follow-up',{exact:true})).toHaveCount(1)
 assert.equal(await f.page.evaluate(()=>window.receivedTurns.length),1)
})
