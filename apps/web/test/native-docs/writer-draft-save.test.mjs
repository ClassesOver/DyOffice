import test from 'node:test'
import assert from 'node:assert/strict'
import {Readable} from 'node:stream'
import {fileURLToPath} from 'node:url'
import {readFile} from 'node:fs/promises'
import {expect} from '@playwright/test'
import JSZip from 'jszip'
import {launchTestBrowser,recordVerifiedOfficeEffect} from '../helpers/browser.mjs'
import {fileFixture,docxBytes,importFile} from '../helpers/files.mjs'
import {mockProviderNetwork} from '../helpers/provider-network.mjs'
import {password} from '../helpers/identity.mjs'
import {buildLocalApp} from '../../server/src/app.ts'
import {createGlobalConfigService} from '../../server/src/modules/admin/service.ts'

const frame=(delta,finish_reason=null)=>Buffer.from('data: '+JSON.stringify({choices:[{delta,finish_reason}]})+'\n\n')
const done=Buffer.from('data: [DONE]\n\n')
const liveConfig=process.env.DYOFFICE_LIVE_WORD_WRITER_CONFIG

test(liveConfig?'native Word writes and saves a real model response in the current DOCX':'native Word never persists a live writer draft and saves the accepted final body on a later save',{timeout:180_000},async t=>{
 const release=Promise.withResolvers();t.after(()=>release.resolve())
 const origin='http://localhost:4251',f=await fileFixture(t,{origin})
 const keyring={activeKeyId:'test',keys:{test:new Uint8Array(32).fill(25)}}
 const profile={deploymentId:f.deploymentId,entryId:'primary',revision:1,providerId:'openai',model:'synthetic',baseUrl:'https://provider.example/v1',endpoint:'https://provider.example/v1/chat/completions',allowedIpv4:['8.8.8.8'],maxOutputTokens:1024}
 const entry=liveConfig?JSON.parse(await readFile(liveConfig,'utf8')).entry:{id:profile.entryId,kind:'chat',providerId:profile.providerId,label:'Synthetic writer fixture',model:profile.model,baseUrl:profile.baseUrl,enabled:true,apiKey:'synthetic-private-key'}
 assert.ok(entry?.enabled&&entry?.apiKey&&entry?.kind==='chat','Enabled test model configuration required')
 await createGlobalConfigService({transactions:f.transactions,keyring}).saveGlobalConfig(f.adminSigned.token,0,{upserts:[entry],defaults:{chat:entry.id}})
 if(!liveConfig)await f.ownerPool.query('INSERT INTO provider_budget_accounts(deployment_id,owner_id,entry_id,config_revision,available_units,per_call_units) VALUES($1,$2,$3,1,100,10)',[f.deploymentId,f.alice.user.id,profile.entryId])
 await f.preferences.update(f.alice.token,{language:'en',autoSave:!liveConfig,showAssistant:true})
 const original=await docxBytes()
 const opened=liveConfig?await importFile(f,f.alice.token,original):await (async()=>{
  const {uploadId}=await f.files.stageUpload(f.alice.token,{name:'未命名.docx',size:original.length,autoName:true})
  await f.files.receiveUpload(f.alice.token,uploadId,original)
  return f.files.finishUpload(f.alice.token,uploadId)
 })()
 const app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,globalConfigKeyring:keyring,providerGateway:liveConfig?{mode:'shared'}:{profiles:[profile]},nativeDocsDirectory:process.env.DYOFFICE_TEST_DOCS_DIST??fileURLToPath(new URL('../../dist-docs',import.meta.url))})
 f.cleanup.push(()=>app.close());await app.listen({host:'127.0.0.1',port:4251})
 const browser=await launchTestBrowser();t.after(()=>browser.close())
 const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message))
 const {csrfToken}=await(await page.request.get(origin+'/api/v1/auth/csrf')).json()
 assert.equal((await page.request.post(origin+'/api/v1/auth/login',{headers:{origin,'x-csrf-token':csrfToken},data:{username:'alice',password}})).status(),200)
 let turn=0
 const network=liveConfig?undefined:mockProviderNetwork(t,()=>{
  const current=turn++
  if(current===0)return Readable.from([frame({tool_calls:[{index:0,id:'writer-fixture',type:'function',function:{name:'write_document',arguments:JSON.stringify({plan:'Write the synthetic fixture paragraph',afterBlockIndex:0})}}]},'tool_calls'),done])
  if(current===1)return Readable.from((async function*(){yield frame({content:'<h1>Orchid Handover</h1><p>STREAMING_WRITER_MARKER'});await release.promise;yield frame({content:' accepted final body</p>'},'stop');yield done})())
  return Readable.from([frame({content:'Synthetic writer completed.'},'stop'),done])
 })
 await page.goto(origin+'/native-docx/?fileId='+opened.file.fileId)
 const editor=page.locator('.tiptap.doc-page').first()
 await expect(editor).toBeVisible({timeout:45_000})
 if(await page.locator('.ai-rail').isVisible())await page.locator('.ai-rail').click()
 await expect(page.getByRole('button',{name:'Model: '+entry.model,exact:true})).toBeVisible()
 const composer=page.locator('.ai-panel textarea')
 const savedText=liveConfig?'Acceptance starts on Friday.':'STREAMING_WRITER_MARKER accepted final body'
 await composer.fill(liveConfig?'Write a short handover document directly in this open Word file after the first paragraph. Use the document writer. Include the title Orchid Handover and this exact sentence: '+savedText:'Write the synthetic fixture after the first paragraph');await composer.press('Enter')
 if(network){
 await expect(editor).toContainText('STREAMING_WRITER_MARKER',{timeout:30_000})
 // The actual autosave blur handler must settle a refused save, not stage the temporary body.
 await page.evaluate(()=>window.dispatchEvent(new Event('blur')))
 await expect(page.locator('.dyoffice-docs-persistence-state')).toHaveAttribute('data-native-save','incomplete')
 assert.equal((await f.files.openFile(f.alice.token,opened.file.fileId)).file.revision,opened.file.revision)
 assert.deepEqual(await f.files.readFile(f.alice.token,opened.file.fileId,opened.file.revision),original)
 release.resolve()
 await expect(page.locator('.ai-panel').getByText('Synthetic writer completed.',{exact:true})).toBeVisible({timeout:30_000})
 }else{
  await expect(editor).toContainText('Orchid Handover',{timeout:90000})
 }
 await expect(editor).toContainText(savedText,{timeout:30000})
 await expect(page.locator('.ai-panel .ai-stop-btn')).toHaveCount(0,{timeout:30000})
 assert.equal((await f.files.openFile(f.alice.token,opened.file.fileId)).file.revision,opened.file.revision)
 const committed=page.waitForResponse(response=>response.url().endsWith('/commits')&&response.status()===200)
 await page.keyboard.press('Control+s');await committed
 await expect(page.locator('.dyoffice-docs-persistence-state')).toHaveAttribute('data-dirty','false')
 if(network)await expect.poll(async()=>(await f.files.openFile(f.alice.token,opened.file.fileId)).name).toBe('Orchid Handover.docx')
 const saved=(await f.files.openFile(f.alice.token,opened.file.fileId)).file
 assert.notEqual(saved.revision,opened.file.revision)
 const zip=await JSZip.loadAsync(await f.files.readFile(f.alice.token,saved.fileId,saved.revision))
 const xml=await zip.file('word/document.xml').async('string')
 assert.ok(xml.includes(savedText))
 if(liveConfig)assert.ok(xml.includes('Orchid Handover'))
 assert.deepEqual(await f.files.readFile(f.alice.token,opened.file.fileId,opened.file.revision),original)
 await page.reload();await expect(page.locator('.tiptap.doc-page').first()).toContainText(savedText,{timeout:30_000})
 if(network)assert.equal(network.writes,3)
 assert.deepEqual(errors,[])
 recordVerifiedOfficeEffect('docx','write_document')
})
