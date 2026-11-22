import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:https'
import { fileURLToPath } from 'node:url'
import { chromium, expect } from '@playwright/test'
import JSZip from 'jszip'
import { fileFixture, docxBytes, importFile } from '../helpers/files.mjs'
import { password } from '../helpers/identity.mjs'
import { phaseDiagnostics, observeFirstRequest } from '../helpers/phase-diagnostics.mjs'
import { withInputDiagnostics } from '../helpers/input-diagnostics.mjs'
import { holdFirstResponseEnd } from '../helpers/delayed-http-response.mjs'
import { hashProtectionPassword, parseDocx, saveDocx } from '../../../../packages/docx-engine/src/index.ts'

const docsDirectory = fileURLToPath(new URL('../../dist-docs/',import.meta.url))
async function fixture(t, {beforeCleanup = () => {}, beforeHttpRequest = () => {}, assistantChannels = false} = {}) {
  const directory = await mkdtemp(join(tmpdir(),'dyoffice-native-docs-'))
  let f, browser, server
  t.after(async () => {
    beforeCleanup()
    await browser?.close()
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
    await f?.app.close()
    await rm(directory,{ recursive: true,force: true })
  })
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(directory,'key.pem'),'-out',join(directory,'cert.pem'),'-days','1','-subj','/CN=localhost'],{ stdio: 'pipe' })
  // HTTP-only persistence fixture: no WebSocket upgrade is attached. A reconnect
  // notice is expected and must not replace the independent save-state assertions.
  server = createServer({ key: await readFile(join(directory,'key.pem')),cert: await readFile(join(directory,'cert.pem')) },(req,res) => {
    beforeHttpRequest(req,res)
    f.app.routing(req,res)
  })
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve))
  const origin = `https://127.0.0.1:${server.address().port}`
  f = await fileFixture(t,{ origin,nativeDocsDirectory: docsDirectory,assistantChannels })
  await f.preferences.update(f.alice.token,{ language: 'en',autoSave: false,showAssistant: false })
  const zip = await JSZip.loadAsync(await docxBytes())
  zip.file('customXml/dyoffice-preserve.xml','<probe>Untouched custom part</probe>')
  const original = await zip.generateAsync({ type: 'nodebuffer' }), opened = await importFile(f,f.alice.token,original,'native-roundtrip.docx')
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ ignoreHTTPSErrors: true,viewport: { width: 1440,height: 1100 } }), page = await context.newPage()
  await page.goto(origin + '/')
  const status = await page.evaluate(async password => {
    const challenge = await (await fetch('/api/v1/auth/csrf')).json()
    return (await fetch('/api/v1/auth/login',{ method: 'POST',headers: { 'content-type': 'application/json','x-csrf-token': challenge.csrfToken },body: JSON.stringify({ username: 'alice',password }) })).status
  },password)
  assert.equal(status,200)
  return { ...f, original, opened, browser, context, page, origin }
}

// Do not treat a reconnect banner or an HTTP commit as proof of a clean native model.
async function expectCleanPersistence(page) {
  const status=page.locator('.dyoffice-docs-persistence-state')
  try {
    await expect(status).toHaveText('Editing')
    await expect(status).toHaveAttribute('data-dirty','false')
  } catch (error) {
    // Bounded state-only diagnostics: no document text, identities, URLs or tokens.
    console.error('native-save-state',JSON.stringify({
      outcome:await status.getAttribute('data-native-save'),
      reasons:await status.getAttribute('data-incomplete-reasons'),
      dirty:await status.getAttribute('data-dirty'),
      notification:await page.locator('.dyoffice-docs-notification-state').count()>0,
    }))
    throw error
  }
}

test('native Word shares live draft text only after consent and stops after saving', { timeout: 90_000 }, async t => {
  const f = await fixture(t), fileId = f.opened.file.fileId
  const opening = f.page.waitForEvent('popup')
  await f.page.evaluate(({origin,fileId}) => {
    window.receivedDrafts = []
    const child = window.open(origin + '/native-docx/?fileId=' + fileId)
    window.addEventListener('message', event => {
      if (event.origin === origin && event.source === child && event.data?.type === 'dsh-dyoffice:draft')
        window.receivedDrafts.push(event.data.draft)
    })
    setInterval(() => child.postMessage({type:'dsh-dyoffice:draft-request',fileId},origin),200)
  },{origin:f.origin,fileId})
  const popup = await opening
  const editor = popup.locator('.tiptap.doc-page[contenteditable="true"]')
  await editor.waitFor({timeout:45000})
  await editor.click()
  await popup.keyboard.press('Control+End')
  await popup.keyboard.press('Enter')
  await popup.keyboard.insertText('Draft shared before save')
  const share = popup.getByRole('button',{name:'Share unsaved text with DSH'})
  await expect(share).toBeVisible()
  assert.deepEqual(await f.page.evaluate(() => window.receivedDrafts),[])
  await share.click()
  await expect.poll(() => f.page.evaluate(() => window.receivedDrafts.at(-1)?.text)).toContain('Draft shared before save')
  assert.equal((await f.files.openFile(f.alice.token,fileId)).file.revision,f.opened.file.revision)
  await editor.click()
  await popup.keyboard.press('Control+s')
  await expect.poll(() => f.page.evaluate(() => window.receivedDrafts.at(-1)),{timeout:20000}).toBe(null)
})

async function openStreamedDshDraft(t) {
  const f = await fixture(t,{assistantChannels:true})
  const {createCsrfService} = await import('../../server/src/modules/auth/csrf.ts')
  const csrf = createCsrfService({db:f.db,deploymentId:f.deploymentId,origin:f.origin,key:f.csrfKey})
  const base = '/api/v1/assistant-channels'
  const post = (path,payload,headers={cookie:'__Host-dyoffice-session='+f.alice.token,origin:f.origin,'x-csrf-token':csrf.sessionToken(f.alice.token)}) =>
    f.app.inject({method:'POST',url:base+path,headers,payload})
  const channel = await post('/channels',{})
  assert.equal(channel.statusCode,200,channel.body)
  const member = await post('/channels/'+channel.json().conversationId+'/dsh-token',{allowCreate:true})
  assert.equal(member.statusCode,200,member.body)
  const headers = {authorization:'Bearer '+member.json().memberToken}
  const created = await post('/member/documents',{format:'docx',title:'Direct draft'},headers)
  assert.equal(created.statusCode,200,created.body)
  const {fileId,previewProof} = created.json()
  const grant = await post('/member/documents/'+fileId+'/draft-sync',{origin:f.origin,write:true},{...headers,'x-dyoffice-document-preview':previewProof})
  assert.equal(grant.statusCode,200,grant.body)
  const initial = (await f.files.openFile(f.alice.token,fileId)).file.revision
  await f.context.route('**/api/v1/ai/catalog',route=>route.fulfill({json:{entries:[{id:'office-model',label:'Office model'}],defaultId:'office-model'}}))
  await f.context.addInitScript(()=>{
    const fetch=window.fetch.bind(window)
    window.officeDraftRequests=[]
    window.fetch=(resource,init)=>{
      if(resource!=='/api/v1/ai/turns' || init?.method!=='POST')return fetch(resource,init)
      window.officeDraftRequests.push(JSON.parse(init.body))
      const event=(type,data)=>new TextEncoder().encode('event: '+type+'\ndata: '+JSON.stringify(data)+'\n\n')
      if(window.officeDraftRequests.length===1) {
        return Promise.resolve(new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(event('tool_call',{id:'write-plan',name:'write_document',input:{plan:'概述目标和流程'}}))
            controller.enqueue(event('done',{}))
            controller.close()
          },
        }),{headers:{'Content-Type':'text/event-stream'}}))
      }
      if(window.officeDraftRequests.length>2) {
        const request=window.officeDraftRequests.at(-1).request
        const question=request.messages.at(-1).text
        const text=request.messages.at(-1).role==='tool'?'Word 草稿已完成。':
          question?.includes('怎么安排签到？')?'收到：怎么安排签到？':question?.includes('再简短说明一下')?'收到：再简短说明一下':'本地对话正常。'
        return Promise.resolve(new Response(
          `event: delta\ndata: ${JSON.stringify({text})}\n\nevent: done\ndata: {}\n\n`,
          {headers:{'Content-Type':'text/event-stream'}}))
      }
      return Promise.resolve(new Response(new ReadableStream({
        start(controller){
          controller.enqueue(event('delta',{text:'<h1>活动目标</h1><p>提高交流效率</p>'}))
          window.finishOfficeDraft=(reason)=>{
            try { controller.enqueue(event('delta',{text:'<h2>活动流程</h2><p>签到和交流</p>'})) } catch { return }
            if(reason) controller.enqueue(event('stop_reason',{reason}))
            controller.enqueue(event('done',{}))
            controller.close()
          }
        },
        cancel(){},
      }),{headers:{'Content-Type':'text/event-stream'}}))
    }
  })
  const opening = f.page.waitForEvent('popup')
  await f.page.evaluate(({origin,fileId,ticket}) => {
    window.receivedDrafts = []
    window.writing = {id:crypto.randomUUID(),topic:'活动策划',skill:{name:'events',content:'Include a registration desk. '+ 'Task reference. '.repeat(170)+'Include the event owner.'}}
    window.writeReceipt = null
    const child = window.open(origin+'/native-docx/?fileId='+fileId)
    window.addEventListener('message', event => {
      if (event.origin === origin && event.source === child && event.data?.type === 'dsh-dyoffice:draft') {
        window.receivedDrafts.push(event.data.draft)
        window.writeReceipt = event.data.writing
        window.officeAnswer = event.data.followup
      }
    })
    setInterval(() => child.postMessage({type:'dsh-dyoffice:draft-request',fileId,ticket,writing:window.writing,followup:window.officeQuestion},origin),250)
  },{origin:f.origin,fileId,ticket:grant.json().ticket})
  const popup = await opening
  const editor = popup.locator('.tiptap.doc-page[contenteditable="true"]')
  await editor.waitFor({timeout:45000})
  await expect(popup.getByRole('button',{name:'Pause live text'})).toBeVisible()
  await expect.poll(() => f.page.evaluate(() => window.writeReceipt?.state)).toBe('writing')
  await expect(editor).toContainText('提高交流效率')
  const assistant=popup.getByRole('complementary',{name:'AI Assistant'})
  const conversation=assistant.locator('.ai-chat')
  await expect(conversation.locator('.ai-msg-user').filter({hasText:'活动策划'})).toHaveCount(1)
  await expect(conversation.locator('.ai-msg-assistant .ai-work-group-summary.running')).toBeVisible()
  const requests=await popup.evaluate(()=>window.officeDraftRequests)
  assert.equal(requests.length,2)
  assert.equal(requests[0].modelId,'office-model')
  assert.match(requests[0].request.messages.at(-1).text,/活动策划/)
  assert.ok(requests[0].request.tools.some(t=>t.name==='write_document'))
  assert.match(requests[0].request.messages.at(-1).text,/Include a registration desk/)
  assert.match(requests[1].request.messages.at(-1).text,/Include a registration desk/)
  assert.match(requests[1].request.messages.at(-1).text,/Include the event owner/)
  assert.deepEqual(requests[1].request.tools,[])
  assert.match(requests[1].request.messages.at(-1).text,/概述目标和流程/)
  await expect.poll(() => f.page.evaluate(() => window.receivedDrafts.at(-1)?.text)).toContain('提高交流效率')
  assert.equal((await f.files.openFile(f.alice.token,fileId)).file.revision,initial)
  const finish = reason => popup.evaluate(value => window.finishOfficeDraft(value),reason)
  return {f,popup,conversation,editor,fileId,initial,finish}
}

test('native Word streams DyOffice writing and shows the returned DSH review', { timeout: 90_000 }, async t => {
  const {f,popup,conversation,fileId,initial,finish} = await openStreamedDshDraft(t)
  await finish()
  await expect.poll(() => f.page.evaluate(() => window.writeReceipt?.state),{timeout:20_000}).toBe('saved')
  const saved = (await f.files.openFile(f.alice.token,fileId)).file
  assert.notEqual(saved.revision, initial)
  assert.equal(await f.page.evaluate(()=>window.writeReceipt.revision),saved.revision)
  assert.deepEqual(await f.page.evaluate(()=>Object.keys(window.writeReceipt).sort()),['id','reply','revision','state'])
  await f.page.evaluate(()=>{window.writing.review={state:'ready',text:'建议明确活动负责人与场地。'}})
  await expect(conversation.locator('.ai-msg-assistant').filter({hasText:'Word 草稿已完成。'})).toHaveCount(1)
  await expect(conversation.locator('.dyoffice-collaboration-message').filter({hasText:'建议明确活动负责人与场地。'})).toBeVisible()
  assert.equal(await f.page.evaluate(()=>window.writeReceipt.reply),'Word 草稿已完成。')
  for(const question of ['怎么安排签到？','再简短说明一下']) {
    await f.page.evaluate(question=>{window.officeQuestion={id:crypto.randomUUID(),question}},question)
    await expect(conversation.getByText('收到：'+question,{exact:true})).toBeVisible()
  }
  const requests=await popup.evaluate(()=>window.officeDraftRequests)
  assert.equal(requests.length,5)
  const handoffReport=requests[2].request
  assert.equal(handoffReport.messages.at(-1).role,'tool')
  assert.match(handoffReport.messages.at(-1).results[0].output,/Content written by the system/)
  const followup=requests[4].request
  assert.ok(followup.tools.some(t=>t.name==='write_document'))
  assert.match(followup.messages.at(-1).text,/再简短说明一下/)
  assert.doesNotMatch(JSON.stringify(followup.messages),/Include a registration desk/)
  assert.ok(followup.messages.some(m=>m.role==='assistant'&&m.text?.includes('收到：怎么安排签到？')))
  const zip = await JSZip.loadAsync(await f.files.readFile(f.alice.token,fileId,saved.revision))
  const xml = await zip.file('word/document.xml').async('string')
  assert.match(xml,/提高交流效率/)
  assert.match(xml,/签到和交流/)
  assert.doesNotMatch(xml,/建议明确/)
  const composer=popup.locator('.ai-panel textarea')
  await composer.fill('直接问 Office 的私人问题')
  await composer.press('Enter')
  await expect(conversation.getByText('本地对话正常。',{exact:true})).toBeVisible()
  const native=(await popup.evaluate(()=>window.officeDraftRequests)).at(-1).request
  assert.ok(native.tools.some(tool=>tool.name==='write_document'))
  assert.match(native.messages.at(-1).text,/直接问 Office 的私人问题/)
  assert.ok(native.messages.some(m=>m.role==='assistant'&&m.text?.includes('收到：再简短说明一下')))

})

test('native Word reports truncated writing without handing it to DSH for review', { timeout: 90_000 }, async t => {
  const {f,conversation,fileId,initial,finish} = await openStreamedDshDraft(t)
  await finish('max_tokens')
  await expect.poll(() => f.page.evaluate(() => window.writeReceipt?.state)).toBe('outputLimit')
  await expect(conversation.locator('.ai-msg-assistant')).not.toHaveCount(0)
  assert.equal((await f.files.openFile(f.alice.token,fileId)).file.revision,initial)
})

test('native Word stops streamed DyOffice writing when the user edits the draft', { timeout: 90_000 }, async t => {
  const {f,popup,editor,fileId,initial,finish} = await openStreamedDshDraft(t)
  await editor.click()
  await popup.keyboard.insertText('人工补充')
  await finish()
  await expect.poll(() => f.page.evaluate(() => window.writeReceipt?.state)).toBe('conflict')
  await expect(editor).toContainText('人工补充')
  await expect(editor).not.toContainText('签到和交流')
  assert.equal((await f.files.openFile(f.alice.token,fileId)).file.revision,initial)
})

test('Word AI naming confirms an independent copy of the unsaved draft', {timeout:90000},async t=>{
  const f=await fixture(t),file=f.opened.file,marker='Quarterly review draft'
  await f.preferences.update(f.alice.token,{showAssistant:true})
  await f.context.route('**/api/v1/ai/catalog',route=>route.fulfill({json:{entries:[{id:'mock',label:'Test model'}],defaultId:'mock'}}))
  const requests=[]
  await f.context.route('**/api/v1/ai/turns',route=>{
    requests.push(route.request().postDataJSON())
    return route.fulfill({contentType:'text/event-stream',body:'event: delta\ndata: {"text":"Quarterly review.docx"}\n\nevent: done\ndata: {}\n\n'})
  })
  await f.page.goto(f.origin+'/native-docx/?fileId='+file.fileId)
  const editor=f.page.locator('.tiptap.doc-page[contenteditable="true"]')
  await editor.waitFor({timeout:45000})
  await editor.first().click()
  // The model names the document from its opening excerpt; this fixture is longer.
  await f.page.keyboard.press('Control+Home')
  await f.page.keyboard.insertText(marker)
  await f.page.keyboard.press('Enter')
  await expect(f.page.locator('.dyoffice-docs-persistence-state')).toHaveAttribute('data-dirty','true')
  await f.page.getByRole('button',{name:'File',exact:true}).click()
  const namingButton=f.page.locator('.qa-name-with-ai')
  await expect(namingButton).toBeEnabled()
  // A background proof request must not consume the refusal intended for naming.
  const proofPath='**/api/v1/auth/session-proof',denyProof=route=>route.fulfill({status:503,json:{}})
  await f.page.route(proofPath,denyProof)
  try {
    await namingButton.click()
    await expect(f.page.getByText('Could not verify this workspace session. Your draft is still open.')).toBeVisible()
    assert.equal(requests.length,0)
  } finally {
    await f.page.unroute(proofPath,denyProof)
  }
  async function choose(name){
    await f.page.getByRole('button',{name:'File',exact:true}).click()
    const button=f.page.locator('.qa-name-with-ai')
    await expect(button).toBeEnabled()
    await button.click()
    const confirmation=f.page.getByRole('dialog',{name:'Save a copy to your workspace'})
    const input=confirmation.getByRole('textbox',{name:'File name'})
    await expect(input).toHaveValue('Quarterly review.docx')
    if(name!==null)await input.fill(name)
    await confirmation.getByRole('button',{name:name===null?'Cancel':'Save copy'}).click()
    await expect(confirmation).toHaveCount(0)
  }
  await choose(null)
  assert.equal((await f.files.listFiles(f.alice.token)).files.length,1)
  await choose('Reviewed quarterly notes')
  await expect.poll(async()=>(await f.files.listFiles(f.alice.token)).files.length).toBe(2)
  const copy=(await f.files.listFiles(f.alice.token)).files.find(item=>item.name==='Reviewed quarterly notes.docx')
  assert.ok(copy)
  const archive=await JSZip.loadAsync(await f.files.readFile(f.alice.token,copy.id,copy.revision))
  assert.ok((await archive.file('word/document.xml').async('string')).replace(/<[^>]+>/g,'').includes(marker))
  assert.deepEqual(await f.files.readFile(f.alice.token,file.fileId,file.revision),f.original)
  assert.equal((await f.files.openFile(f.alice.token,file.fileId)).file.revision,file.revision)
  await expect(f.page.locator('.dyoffice-docs-persistence-state')).toHaveAttribute('data-dirty','true')
  assert.equal(requests.length,2)
  for(const {modelId,request} of requests){
    assert.equal(modelId,'mock');assert.equal(request.format,'docx');assert.deepEqual(request.tools,[])
    assert.ok(request.messages[0].text.includes(marker))
  }
})

test('native DyOffice DOCX renders, edits, commits, refreshes and preserves unrelated original parts', { timeout: 120_000 }, async t => {
  const f = await fixture(t), errors = []
  const filePath = '/native-docx/?fileId=' + f.opened.file.fileId
  const cookie = token => ({ cookie: '__Host-dyoffice-session=' + token })
  assert.equal((await f.app.inject({ url: filePath })).statusCode,401)
  assert.equal((await f.app.inject({ url: filePath,headers: cookie(f.bob.token) })).statusCode,404)
  const html = await f.app.inject({ url: filePath,headers: cookie(f.alice.token) })
  assert.equal(html.statusCode,200)
  assert.deepEqual((await f.app.inject({ url: '/api/v1/capabilities',headers: cookie(f.alice.token) })).json(),{ docx: 'editable',xlsx: 'unsupported',pptx: 'unsupported',pdf: 'unsupported' })
  assert.equal((await f.app.inject({ url: '/api/v1/files/' + f.opened.file.fileId,headers: cookie(f.alice.token) })).json().capabilities.docx,'editable')
  assert.equal(html.headers['cache-control'],'private, no-store')
  const asset = html.body.match(/src="([^"]+\.js)"/)[1]
  assert.equal((await f.app.inject({ url: asset })).statusCode,401)
  assert.equal((await f.app.inject({ url: asset,headers: cookie(f.alice.token) })).statusCode,200)
  assert.equal((await f.app.inject({ url: '/native-docx/src/editors/docs-entry.tsx',headers: cookie(f.alice.token) })).statusCode,404)
  assert.equal((await f.app.inject({ url: `/api/v1/files/${f.opened.file.fileId}/revisions/${f.opened.file.revision}`,headers: cookie(f.bob.token) })).statusCode,404)
  f.page.on('pageerror' ,error => errors.push(String(error)))
  const response = await f.page.goto(f.origin + '/native-docx/?fileId=' + f.opened.file.fileId)
  assert.equal(response.status(),200)
  const editor = f.page.locator('.tiptap.doc-page[contenteditable="true"]')
  await editor.waitFor({ timeout: 45_000 })
  const marker = 'Web native paragraph 2026'
  await editor.click()
  await f.page.keyboard.press('Control+End'); await f.page.keyboard.press('Enter'); await f.page.keyboard.type(marker)
  assert.ok((await editor.innerText()).includes(marker))
  await f.page.keyboard.press('Control+z')
  assert.ok(!(await editor.innerText()).includes(marker))
  await f.page.keyboard.press('Control+Shift+z')
  assert.ok((await editor.innerText()).includes(marker))
  await f.page.keyboard.press('Enter')
  await f.page.getByRole('button',{ name: 'Insert',exact: true }).click()
  await f.page.getByRole('button',{ name: 'Table',exact: true }).click()
  await f.page.locator('.table-picker-grid .table-cell').nth(11).click()
  const cell = editor.locator('table td').first()
  await cell.click(); await f.page.keyboard.type('Native table cell')
  assert.equal(await editor.locator('table tr').count(),2)
  await f.context.grantPermissions(['clipboard-read','clipboard-write'])
  await f.page.evaluate(() => navigator.clipboard.writeText(' 浏览器剪贴板'))
  await f.page.keyboard.press('Control+v')
  await expect(cell).toContainText('浏览器剪贴板')
  const committed = f.page.waitForResponse(reply => reply.url().endsWith('/commits') && reply.request().method() === 'POST' && reply.status() === 200)
  await f.page.keyboard.press('Control+s')
  await committed
  const opened = await f.files.openFile(f.alice.token,f.opened.file.fileId)
  assert.notEqual(opened.file.revision,f.opened.file.revision)
  const bytes = await f.files.readFile(f.alice.token,opened.file.fileId,opened.file.revision), archive = await JSZip.loadAsync(bytes)
  assert.ok((await archive.file('word/document.xml').async('string')).replace(/<[^>]+>/g,'').includes(marker))
  assert.ok((await archive.file('word/document.xml').async('string')).includes('Native table cell'))
  assert.ok((await archive.file('word/document.xml').async('string')).includes('浏览器剪贴板'))
  assert.equal(await archive.file('customXml/dyoffice-preserve.xml').async('string'),'<probe>Untouched custom part</probe>')
  await expectCleanPersistence(f.page)
  await f.page.getByRole('button',{ name: 'File',exact: true }).click()
  const savedDownload = f.page.getByRole('link',{ name: 'Download saved version',exact: true })
  await expect(savedDownload).toBeVisible()
  const [download] = await Promise.all([
    f.page.waitForEvent('download'),
    savedDownload.click(),
  ])
  assert.equal(download.suggestedFilename(),'native-roundtrip.docx')
  assert.deepEqual(await readFile(await download.path()),bytes)
  const history = await f.context.request.get(`${f.origin}/api/v1/files/${opened.file.fileId}/revisions`)
  assert.equal(history.status(),200)
  assert.equal((await history.json()).revisions.length,2)
  await expectCleanPersistence(f.page)
  await f.page.reload()
  await f.page.locator('.tiptap.doc-page').waitFor({ timeout: 45_000 })
  await expect(f.page.locator('.tiptap.doc-page')).toContainText(marker,{ timeout: 45_000 })
  await expect(f.page.locator('.tiptap.doc-page table')).toContainText('Native table cell')
  assert.deepEqual(errors,[])
})

test('native Word saves a styled paragraph and an anchored review comment', {timeout:120_000}, async t => {
  const f = await fixture(t), {page} = f
  const original = await readFile(new URL('../../../shell/build/shell-new/blank.docx',import.meta.url))
  const {file} = await importFile(f,f.alice.token,original,'styled-review.docx')
  const title = 'F01 review heading', comment = 'Review the native heading before release.'
  await page.goto(f.origin+'/native-docx/?fileId='+file.fileId)
  const editor = page.locator('.tiptap.doc-page[contenteditable="true"]')
  await editor.waitFor({timeout:45_000})
  await editor.click()
  await page.keyboard.type(title)
  await page.getByRole('button',{name:'Styles',exact:true}).click()
  await page.locator('.style-gallery-menu [data-style-id="Heading1"]').click()
  await expect(editor.getByRole('heading',{name:title,level:1})).toBeVisible()

  await page.getByRole('button',{name:'Review',exact:true}).click()
  await editor.getByRole('heading',{name:title,level:1}).click()
  await page.keyboard.press('Home')
  await page.keyboard.press('Shift+End')
  await expect.poll(()=>page.evaluate(()=>window.getSelection()?.toString())).toBe(title)
  await page.getByRole('button',{name:'New Comment',exact:true}).click()
  await page.getByPlaceholder('Type a comment…').fill(comment)
  await page.locator('.comment-compose').getByRole('button',{name:'Comment',exact:true}).click()
  const commentsPane = page.locator('.comments-pane')
  await expect(commentsPane.locator('.comment-text')).toHaveText(comment)

  const committed = page.waitForResponse(reply=>reply.url().endsWith('/commits')&&reply.request().method()==='POST'&&reply.status()===200)
  await page.keyboard.press('Control+s')
  await committed
  await expectCleanPersistence(page)
  const current = (await f.files.openFile(f.alice.token,file.fileId)).file
  assert.notEqual(current.revision,file.revision)
  await page.getByRole('button',{name:'File',exact:true}).click()
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('link',{name:'Download saved version',exact:true}).click(),
  ])
  const bytes = await readFile(await download.path())
  assert.deepEqual(bytes,await f.files.readFile(f.alice.token,file.fileId,current.revision))
  assert.deepEqual(await f.files.readFile(f.alice.token,file.fileId,file.revision),original)
  const archive = await JSZip.loadAsync(bytes)
  const commentsXml = await archive.file('word/comments.xml').async('string')
  assert.ok(commentsXml.includes(comment))
  const commentId = commentsXml.match(/<w:comment\b[^>]*\bw:id="(\d+)"/)?.[1]
  assert.ok(commentId)
  const documentXml = await archive.file('word/document.xml').async('string')
  const headingXml = [...documentXml.matchAll(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)].find(([xml])=>xml.includes(title))?.[0]
  assert.ok(headingXml)
  assert.match(headingXml,/<w:pStyle\s+w:val="Heading1"/)
  const start = headingXml.indexOf(`<w:commentRangeStart w:id="${commentId}"`)
  const end = headingXml.indexOf(`<w:commentRangeEnd w:id="${commentId}"`)
  const content = headingXml.indexOf(title)
  assert.ok(start>=0&&start<content&&content<end,'comment must anchor the saved heading text')
  assert.ok(headingXml.includes(`<w:commentReference w:id="${commentId}"`))
  assert.match(await archive.file('word/_rels/document.xml.rels').async('string'),/Target="comments\.xml"/)
  assert.match(await archive.file('[Content_Types].xml').async('string'),/PartName="\/word\/comments\.xml"/)

  await page.reload()
  await expect(editor.getByRole('heading',{name:title,level:1})).toBeVisible({timeout:45_000})
  await page.locator('.ribbon-mode-split .mode-menu-wrap').getByRole('button',{name:'Show Comments',exact:true}).click()
  await page.getByRole('menuitemradio',{name:'List',exact:true}).click()
  await expect(commentsPane.locator('.comment-card')).toContainText(comment)
  await expect(commentsPane.locator('.comment-anchor')).toContainText(title)
})

test('native Word preserves modify-password protection across read-only open, edit and save',{timeout:120_000},async t=>{
  const f=await fixture(t),{page}=f
  const modifyPassword='Synthetic acceptance password'
  const document=await parseDocx(f.original)
  const originalBlocks=document.blocks.filter(block=>!block.hidden&&block.docxIndex!==null)
    .map(block=>({kind:'original',docxIndex:block.docxIndex}))
  const original=Buffer.from(await saveDocx(document,originalBlocks,{
    writeProtection:await hashProtectionPassword(modifyPassword,1000),
  }))
  const {file}=await importFile(f,f.alice.token,original,'write-protected.docx')
  const revision=async()=>(await f.files.openFile(f.alice.token,file.fileId)).file.revision
  await page.goto(f.origin+'/native-docx/?fileId='+file.fileId)
  const dialog=page.getByRole('dialog').filter({hasText:'Write-Protected'})
  const editor=page.locator('.tiptap.doc-page')
  await expect(dialog).toBeVisible({timeout:45000})
  await dialog.locator('input').fill('Incorrect fixture password')
  await dialog.getByRole('button',{name:'OK',exact:true}).click()
  await expect(dialog.getByText('The password is incorrect. Try again.')).toBeVisible()
  await dialog.getByRole('button',{name:'Open Read-Only',exact:true}).click()
  await expect(editor).toHaveAttribute('contenteditable','false')
  await editor.click()
  await page.keyboard.type('This edit must be blocked')
  await expect(editor).not.toContainText('This edit must be blocked')
  await expect(page.getByRole('button',{name:/^Save \(/})).toBeDisabled()
  assert.equal(await revision(),file.revision)
  await page.getByRole('button',{name:'File',exact:true}).click()
  const [download]=await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('link',{name:'Download saved version',exact:true}).click(),
  ])
  assert.deepEqual(await readFile(await download.path()),original)

  await page.reload()
  await expect(dialog).toBeVisible({timeout:45000})
  await dialog.locator('input').fill(modifyPassword)
  await dialog.getByRole('button',{name:'OK',exact:true}).click()
  await expect(dialog).toHaveCount(0)
  await expect(editor).toHaveAttribute('contenteditable','true')
  await editor.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.press('Enter')
  const marker='The authorized edit survived the save.'
  await page.keyboard.type(marker)
  await expect(editor).toContainText(marker)
  const committed=page.waitForResponse(reply=>reply.url().endsWith('/commits')&&reply.request().method()==='POST'&&reply.status()===200)
  await page.keyboard.press('Control+s')
  await committed
  await expectCleanPersistence(page)
  const savedRevision=await revision()
  assert.notEqual(savedRevision,file.revision)
  const saved=await f.files.readFile(f.alice.token,file.fileId,savedRevision)
  const [before,after]=await Promise.all([JSZip.loadAsync(original),JSZip.loadAsync(saved)])
  const protection=(zip)=>zip.file('word/settings.xml').async('string').then(xml=>xml.match(/<w:writeProtection\b[^>]*\/>/)?.[0])
  const expected=await protection(before)
  assert.ok(expected)
  assert.equal(await protection(after),expected)
  assert.deepEqual(await f.files.readFile(f.alice.token,file.fileId,file.revision),original)
  await page.reload()
  await expect(dialog).toBeVisible({timeout:45000})
  await dialog.getByRole('button',{name:'Open Read-Only',exact:true}).click()
  await expect(editor).toHaveAttribute('contenteditable','false')
  await expect(editor).toContainText(marker)
})

test('editing during a delayed native save keeps the newer draft dirty and saves a later child revision', { timeout: 120_000 },async t => {
  const diagnostic = phaseDiagnostics(t.signal)
  t.after(() => diagnostic.dispose())
  try {
  let requestDiagnostic, commitPath
  // Pause the real authenticated server reply after the commit, without a
  // Chromium route.fetch/fulfill replay of the TLS request or its response.
  const held = holdFirstResponseEnd(
    req => req.method === 'POST' && commitPath !== undefined && req.url === commitPath,
    status => { diagnostic.count('commit-response-held'); diagnostic.status(status) },
  )
  const f = await fixture(t, {
    beforeCleanup() { requestDiagnostic?.beginCleanup(); held.release() },
    beforeHttpRequest(req,res) {
      if (held.intercept(req,res)) diagnostic.count('commit-request')
    },
  })
  f.page.on('pageerror', () => diagnostic.count('pageerror'))
  requestDiagnostic = observeFirstRequest(f.page, diagnostic, {signal: t.signal})
  t.after(() => requestDiagnostic.dispose())
  diagnostic.stage('open')
  await f.page.goto(f.origin + '/native-docx/?fileId=' + f.opened.file.fileId)
  const editor = f.page.locator('.tiptap.doc-page[contenteditable="true"]')
  diagnostic.stage('editor-ready')
  await editor.waitFor({ timeout: 45_000 })
  diagnostic.stage('type-first')
  await editor.click(); await f.page.keyboard.press('Control+End'); await f.page.keyboard.press('Enter'); await f.page.keyboard.type('Captured snapshot')
  commitPath = '/api/v1/files/' + f.opened.file.fileId + '/commits'
  const matchesCommit = request => request.method() === 'POST' && request.url() === f.origin + commitPath
  let firstRequest
  const watch = request => {
    if (!matchesCommit(request)) return
    firstRequest = request
    requestDiagnostic.watch(request)
    f.page.off('request',watch)
  }
  f.page.on('request',watch)
  t.after(() => f.page.off('request',watch))
  diagnostic.stage('first-save-key')
  await f.page.keyboard.press('Control+s')
  diagnostic.stage('first-commit-wait')
  assert.equal(await held.started,200)
  assert.ok(firstRequest)
  assert.equal(firstRequest.postDataJSON().baseRevision,f.opened.file.revision)
  diagnostic.stage('edit-newer')
  await editor.click(); await f.page.keyboard.press('Control+End'); await f.page.keyboard.press('Enter'); await f.page.keyboard.type('Newer unsaved draft')
  diagnostic.stage('read-first')
  const firstRef = await f.files.openFile(f.alice.token,f.opened.file.fileId)
  assert.notEqual(firstRef.file.revision,f.opened.file.revision)
  const firstZip = await JSZip.loadAsync(await f.files.readFile(f.alice.token,firstRef.file.fileId,firstRef.file.revision))
  const firstXml = await firstZip.file('word/document.xml').async('string')
  assert.ok(firstXml.includes('Captured snapshot'))
  assert.ok(!firstXml.includes('Newer unsaved draft'))
  // Wait for that exact response and check the native draft still remains
  // dirty after settlement before observing save two.
  const firstResponse = f.page.waitForResponse(reply => reply.request() === firstRequest && reply.status() === 200)
  diagnostic.stage('release')
  held.release()
  diagnostic.stage('first-response-wait')
  const releasedResponse = await firstResponse
  diagnostic.stage('first-response-finished')
  try {
    assert.equal(await requestDiagnostic.finished(releasedResponse),null)
  } catch (error) {
    // Chromium's network event can arrive before the editor settles the save.
    // Record the editor's own verdict without converting a failed request into a pass.
    const state = f.page.locator('.dyoffice-docs-persistence-state')
    const acknowledged = await expect.poll(() => state.evaluate(element =>
      element.textContent === 'Unsaved' && element.getAttribute('data-native-save') === 'incomplete' &&
      (element.getAttribute('data-incomplete-reasons') ?? '').split(',').includes('document'),
    undefined,{ timeout: 500 }),{ timeout: 3000 }).toBe(true).then(() => true,() => false)
    console.error('first-native-save-receipt',JSON.stringify({acknowledged}))
    throw error
  }
  diagnostic.stage('native-incomplete')
  await expect(f.page.locator('.dyoffice-docs-persistence-state')).toHaveAttribute('data-native-save','incomplete')
  diagnostic.stage('native-dirty')
  await expect(f.page.locator('.dyoffice-docs-persistence-state')).toHaveAttribute('data-dirty','true')
  diagnostic.stage('dirty-assert')
  await expect(f.page.locator('.dyoffice-docs-persistence-state')).toHaveText('Unsaved',{ timeout: 15_000 })
  await expect(f.page.locator('.dyoffice-docs-persistence-state')).toHaveAttribute('data-incomplete-reasons',/(^|,)document(,|$)/)
  await expect(editor).toContainText('Newer unsaved draft')
  diagnostic.stage('second-save-wait')
  const next = f.page.waitForResponse(reply => matchesCommit(reply.request()) && reply.request() !== firstRequest && reply.status() === 200)
  await f.page.keyboard.press('Control+s')
  const latestResponse = await next
  assert.equal(latestResponse.request().postDataJSON().baseRevision,firstRef.file.revision)
  diagnostic.stage('read-final')
  const current = await f.files.openFile(f.alice.token,f.opened.file.fileId)
  assert.notEqual(current.file.revision,firstRef.file.revision)
  const currentZip = await JSZip.loadAsync(await f.files.readFile(f.alice.token,current.file.fileId,current.file.revision))
  assert.ok((await currentZip.file('word/document.xml').async('string')).includes('Newer unsaved draft'))
  await expectCleanPersistence(f.page)
  diagnostic.stage('complete')
  } catch (error) { diagnostic.report(); throw error }
})

test('native editor preserves unsaved text and becomes read only after another tab takes over', { timeout: 120_000 },async t => {
  const f = await fixture(t), path = f.origin + '/native-docx/?fileId=' + f.opened.file.fileId
  await f.page.goto(path)
  const editor = f.page.locator('.tiptap.doc-page[contenteditable="true"]')
  await editor.waitFor({ timeout: 45_000 })
  await editor.click(); await f.page.keyboard.press('Control+End'); await f.page.keyboard.type('Unsaved first tab')
  const second = await f.context.newPage()
  await second.goto(path)
  await expect(second.getByRole('button',{ name: 'Take over editing' })).toBeVisible({ timeout: 45_000 })
  await expect(second.locator('.tiptap.doc-page')).toHaveAttribute('contenteditable','false')
  try {
  await second.getByRole('button',{ name: 'Take over editing' }).click()
  } catch(error) {
    const state=await second.evaluate(()=>{
      const button=document.querySelector('[data-takeover-blockers]')
      const allowed=new Set(['loading','no-handle','taking-over','downloading','dirty','local-busy','host-unknown','host-saving'])
      return {present:!!button,disabled:button instanceof HTMLButtonElement?button.disabled:null,blockers:(button?.getAttribute('data-takeover-blockers')??'').split(',').filter(value=>allowed.has(value))}
    }).catch(()=>({unavailable:true}))
    console.error('takeover-state',JSON.stringify(state))
    throw error
  }
  await expect(second.locator('.tiptap.doc-page')).toHaveAttribute('contenteditable','true')
  await f.page.bringToFront()
  await expect(f.page.locator('.tiptap.doc-page')).toHaveAttribute('contenteditable','false',{ timeout: 25_000 })
  await expect(f.page.locator('.tiptap.doc-page')).toContainText('Unsaved first tab')
  assert.equal((await f.files.openFile(f.alice.token,f.opened.file.fileId)).file.revision,f.opened.file.revision)
})

test('native lost-response warning keeps the draft until the original commit receipt is confirmed', { timeout: 120_000 },async t => {
  const f = await fixture(t)
  await withInputDiagnostics(f.page, async () => {
  await f.page.goto(f.origin + '/native-docx/?fileId=' + f.opened.file.fileId)
  const editor = f.page.locator('.tiptap.doc-page[contenteditable="true"]')
  await editor.waitFor({ timeout: 45_000 })
  await editor.click(); await f.page.keyboard.press('Control+End'); await f.page.keyboard.type('Lost response native draft')
  const commits = []; let drop = true
  await f.page.route('**/commits',async route => {
    commits.push(route.request().postDataJSON())
    if (!drop) return route.continue()
    drop = false
    await route.fetch(); await route.abort('failed')
  })
  await f.page.keyboard.press('Control+s')
  await expect(f.page.getByRole('button',{ name: 'Confirm save outcome' })).toBeVisible({ timeout: 15_000 })
  await expect(editor).toContainText('Lost response native draft')
  const current = await f.files.openFile(f.alice.token,f.opened.file.fileId)
  assert.notEqual(current.file.revision,f.opened.file.revision)
  await f.page.getByRole('button',{ name: 'Confirm save outcome' }).click()
  await expect(f.page.getByRole('button',{ name: 'Confirm save outcome' })).toHaveCount(0)
  assert.deepEqual(commits[1],commits[0])
  assert.equal((await f.files.openFile(f.alice.token,f.opened.file.fileId)).file.revision,current.file.revision)
  })
})

// The total deadline covers database setup and three actual server processes.
test('actual server entry serves built native DOCX without a format flag and rejects invalid storage settings', { timeout: 60_000 },async t => {
  const { spawn,execFile } = await import('node:child_process')
  const { once } = await import('node:events'), { promisify } = await import('node:util')
  const f = await fileFixture(t), opened = await importFile(f,f.alice.token,await docxBytes())
  const cwd = fileURLToPath(new URL('../../',import.meta.url))
  const env = { ...process.env,NODE_ENV: 'development',DYOFFICE_AUTH_MODE: 'local',DYOFFICE_DATABASE_URL: '',DYOFFICE_AUTH_DATABASE_URL: f.urls.auth,DYOFFICE_BUSINESS_DATABASE_URL: f.urls.business,DYOFFICE_DEPLOYMENT_ID: f.deploymentId,DYOFFICE_ORIGIN: 'https://office.example',DYOFFICE_CSRF_KEY: f.csrfKey,DYOFFICE_USER_TOKEN: '',DYOFFICE_ADMIN_TOKEN: '',DYOFFICE_OBJECT_STORE: 'local-dev',DYOFFICE_OBJECT_DIRECTORY: f.directory,DYOFFICE_NATIVE_DOCX_DIRECTORY: '',PORT: '0',HOST: '127.0.0.1' }
  const child = spawn(process.execPath,['--import','tsx','server/index.mjs'],{ cwd,env,stdio: ['ignore','pipe','pipe'] })
  f.cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await once(child,'exit') } })
  const exited = once(child,'exit')
  const [output] = await Promise.race([once(child.stdout,'data'),exited.then(() => { throw new Error('Native entry exited before startup') })])
  const address = String(output).match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]
  assert.ok(address)
  const path = address + '/native-docx/?fileId=' + opened.file.fileId, headers = { cookie: '__Host-dyoffice-session=' + f.alice.token }
  assert.equal((await fetch(path)).status,401)
  assert.equal((await fetch(path,{ headers })).status,200)
  assert.equal((await (await fetch(address + '/api/v1/capabilities',{ headers })).json()).docx,'editable')
  child.kill('SIGTERM'); assert.deepEqual(await exited,[0,null])
  for (const invalid of [{ DYOFFICE_OBJECT_STORE: 'invalid' },{ DYOFFICE_OBJECT_DIRECTORY: '' }]) {
    await assert.rejects(promisify(execFile)(process.execPath,['--import','tsx','server/index.mjs'],{ cwd,env: { ...env,...invalid },timeout: 10000 }),error => {
      assert.equal(error.code,1)
      assert.equal(error.stderr.includes(f.urls.auth),false)
      return true
    })
  }
})

test('page-color edits during a delayed native commit remain dirty and persist on the next save', { timeout: 120_000 },async t => {
  const f = await fixture(t)
  await f.page.goto(f.origin + '/native-docx/?fileId=' + f.opened.file.fileId)
  await f.page.locator('.tiptap.doc-page[contenteditable="true"]').waitFor({ timeout: 45_000 })
  let reached, release, first = true
  const started = new Promise(resolve => { reached = resolve }), gate = new Promise(resolve => { release = resolve })
  t.after(() => release())
  await f.page.route('**/commits',async route => {
    if (!first) return route.continue()
    first = false
    const response = await route.fetch()
    reached(); await gate; await route.fulfill({ response })
  })
  await f.page.keyboard.press('Control+s'); await started
  await f.page.getByRole('button',{ name: 'Design',exact: true }).click()
  await f.page.getByRole('button',{ name: 'Page Color',exact: true }).click()
  await f.page.getByRole('gridcell',{ name: 'Red',exact: true }).click()
  release()
  const persistence = f.page.locator('.dyoffice-docs-persistence-state')
  await expect(persistence).toHaveText('Unsaved')
  await expect(persistence).toHaveAttribute('data-native-save','incomplete')
  await expect(persistence).toHaveAttribute('data-dirty','true')
  await expect(persistence).toHaveAttribute('data-incomplete-reasons',/(^|,)metadata:pageColorDirty(,|$)/)
  await expect(f.page.locator('.doc-zoom').first()).toHaveCSS('--page-bg','#FF0000')
  const next = f.page.waitForResponse(reply => reply.url().endsWith('/commits') && reply.status() === 200)
  await f.page.keyboard.press('Control+s'); await next
  await expectCleanPersistence(f.page)
  const current = await f.files.openFile(f.alice.token,f.opened.file.fileId)
  const zip = await JSZip.loadAsync(await f.files.readFile(f.alice.token,current.file.fileId,current.file.revision))
  assert.match(await zip.file('word/document.xml').async('string'),/w:background[^>]*w:color="FF0000"/)
  await f.page.reload()
  await expect(f.page.locator('.doc-zoom').first()).toHaveCSS('--page-bg','#FF0000',{ timeout: 45_000 })
})

for (const theme of ['light', 'dark']) test(`Word saves and downloads the authored page color with the ${theme} UI theme`, { timeout: 120_000 }, async t => {
  const f = await fixture(t)
  await f.preferences.update(f.alice.token, { theme })
  await f.page.goto(f.origin + '/native-docx/?fileId=' + f.opened.file.fileId)
  await expect(f.page.locator('html')).toHaveAttribute('data-theme', theme)
  await f.page.locator('.tiptap.doc-page[contenteditable="true"]').waitFor({ timeout: 45_000 })
  await expectCleanPersistence(f.page)
  await f.page.getByRole('button', { name: 'Design', exact: true }).click()
  await f.page.getByRole('button', { name: 'Page Color', exact: true }).click()
  await f.page.getByRole('gridcell', { name: 'Red', exact: true }).click()
  await expect(f.page.locator('.doc-zoom').first()).toHaveCSS('--page-bg', '#FF0000')
  const persistence = f.page.locator('.dyoffice-docs-persistence-state')
  await expect(persistence).toHaveText('Unsaved')
  await expect(persistence).toHaveAttribute('data-dirty', 'true')
  assert.equal((await f.files.openFile(f.alice.token, f.opened.file.fileId)).file.revision, f.opened.file.revision)
  const committed = f.page.waitForResponse(reply => reply.url().endsWith('/commits') && reply.status() === 200)
  await f.page.keyboard.press('Control+s'); await committed
  await expectCleanPersistence(f.page)
  const current = await f.files.openFile(f.alice.token, f.opened.file.fileId)
  assert.notEqual(current.file.revision, f.opened.file.revision)
  const bytes = await f.files.readFile(f.alice.token, current.file.fileId, current.file.revision)
  await f.page.getByRole('button', { name: 'File', exact: true }).click()
  const [download] = await Promise.all([
    f.page.waitForEvent('download'),
    f.page.getByRole('link', { name: 'Download saved version', exact: true }).click(),
  ])
  const downloadedBytes = await readFile(await download.path())
  assert.deepEqual(downloadedBytes, bytes)
  const zip = await JSZip.loadAsync(downloadedBytes)
  assert.match(await zip.file('word/document.xml').async('string'), /w:background[^>]*w:color="FF0000"/)
  assert.equal(await zip.file('customXml/dyoffice-preserve.xml').async('string'), '<probe>Untouched custom part</probe>')
  await f.page.reload()
  await expect(f.page.locator('.doc-zoom').first()).toHaveCSS('--page-bg', '#FF0000', { timeout: 45_000 })
  await expectCleanPersistence(f.page)
})
