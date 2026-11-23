import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {Readable} from 'node:stream'
import {fileURLToPath} from 'node:url'
import {expect} from '@playwright/test'
import JSZip from 'jszip'
import {buildLocalApp} from '../../server/src/app.ts'
import {createGlobalConfigService} from '../../server/src/modules/admin/service.ts'
import {openIsolatedPptxSession} from '../../worker/src/native/pptx-session-host.ts'
import {launchTestBrowser} from '../helpers/browser.mjs'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {password} from '../helpers/identity.mjs'
import {mockProviderNetwork} from '../helpers/provider-network.mjs'

const slidesDirectory=process.env.DYOFFICE_TEST_SLIDES_DIST
test('a new PPTX tab resumes the conversation once and keeps its edit in the draft until save',{skip:!slidesDirectory,timeout:90000},async t=>{
 const origin='http://localhost:43682',f=await fileFixture(t,{origin,buildApp:false})
 const original=await readFile(new URL('../fixtures/slides/acceptance.pptx',import.meta.url))
 const {file}=await importFile(f,f.alice.token,original,'recover-task.pptx')
 const keyring={activeKeyId:'slides-recovery',keys:{'slides-recovery':new Uint8Array(32).fill(43)}}
 await createGlobalConfigService({transactions:f.transactions,keyring}).saveGlobalConfig(f.adminSigned.token,0,{upserts:[{id:'fixture',kind:'chat',providerId:'openai',label:'Fixture',model:'synthetic',baseUrl:'https://provider.example/v1/chat/completions',apiKey:'fixture-key',enabled:true}],defaults:{chat:'fixture'}})
 await f.preferences.update(f.alice.token,{language:'zh',showAssistant:true,autoSave:false})
 let runs=0,release
 const gate=new Promise(resolve=>{release=resolve})
 const app=await buildLocalApp({
  db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,
  globalConfigKeyring:keyring,providerGateway:{mode:'shared'},nativeSlidesDirectory:slidesDirectory,
  localShellDirectory:process.env.DYOFFICE_TEST_LOCAL_SHELL_DIRECTORY??fileURLToPath(new URL('../../dist-local-shell',import.meta.url)),
  slidesHost:{openSession(input){return openIsolatedPptxSession(input,{timeoutMs:60000,unsafeTestOnly:true})}},
  codingHarnesses:{defaultId:'fixture-calc',adapters:[{descriptor:{id:'fixture-calc',name:'Calculator',capabilities:['coding'],origin:'external'},async run(_input,signal,context){
   runs++
   context.onProgress({kind:'status',text:'Computing PPTX total'})
   await gate
   signal.throwIfAborted()
   return {summary:'Recovered total: 42',output:'42'}
  }}]},
 })
 f.cleanup.unshift(async()=>{release();await app.close()})
 await app.listen({port:43682,host:'127.0.0.1'})
 const browser=await launchTestBrowser();f.cleanup.unshift(()=>browser.close())
 const context=await browser.newContext({viewport:{width:1360,height:900}})
 let page=await context.newPage()
 const {csrfToken}=await (await page.request.get(origin+'/api/v1/auth/csrf')).json()
 assert.equal((await page.request.post(origin+'/api/v1/auth/login',{headers:{origin,'x-csrf-token':csrfToken},data:{username:'alice',password}})).status(),200)
 let panel=page.locator('.ai-panel'),composer=panel.locator('textarea')
 let rail=page.getByRole('button',{name:'展开 AI 助手',exact:true})
 async function openAssistant(){
  await expect(page.locator('html')).toHaveAttribute('data-document-loading','ready',{timeout:25000})
  await expect(composer.or(rail)).toBeVisible({timeout:15000})
  if(await rail.isVisible())await rail.click()
  await expect(composer).toBeVisible()
 }
 const instruction='请委派计算任务，并用结果更新幻灯片标题。'
 const success='已根据任务结果更新演示文稿草稿。',revised='Recovered title 42'
 let edits=0
 const network=mockProviderNetwork(t,()=>{try{
  const {tools,messages}=JSON.parse(network.wire.toString())
  const delegated=messages.find(message=>message.role==='tool'&&message.tool_call_id==='recover-pptx')
  const edited=messages.find(message=>message.role==='tool'&&message.tool_call_id==='recover-pptx-edit')
  const call=(id,name,input)=>({tool_calls:[{index:0,id,type:'function',function:{name,arguments:JSON.stringify(input)}}]})
  let delta
  if(edited){
   const result=JSON.parse(edited.content)
   assert.ok(!result.isError,result.output)
   delta={content:success}
  }else if(delegated){
   assert.ok(!tools.some(tool=>tool.function.name==='delegate_agent_task'))
   assert.match(delegated.content,/Recovered total: 42/)
   assert.equal(++edits,1)
   delta=call('recover-pptx-edit','execute_slide_script',{slideIndex:0,code:`const title = els.find(e => e.text === "Acceptance title"); setText(title.id, "${revised}");`})
  }else delta=call('recover-pptx','delegate_agent_task',{instruction:'Calculate the PPTX total'})
  return Readable.from([Buffer.from('data: '+JSON.stringify({choices:[{delta,finish_reason:delta.tool_calls?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n')])
 }catch(error){t.diagnostic(error.stack);throw error}})
 const submissions=[],cancellations=[],claims=[]
 context.on('request',request=>{
  const path=new URL(request.url()).pathname
  if(request.method()==='POST'&&path==='/api/v1/agents/tasks')submissions.push(request.postDataJSON())
  if(path.startsWith('/api/v1/agents/tasks/')&&path.endsWith('/cancel'))cancellations.push(path)
  if(path.startsWith('/api/v1/agents/tasks/')&&path.endsWith('/continuation'))claims.push(path)
 })
 const documentUrl=origin+'/native-pptx/?fileId='+file.fileId
 await page.goto(documentUrl)
 await openAssistant()
 await composer.fill(instruction)
 await panel.getByRole('button',{name:'发送',exact:true}).click()
 await expect(panel.locator('.assistant-task-message:visible').getByText('Computing PPTX total',{exact:true})).toBeVisible({timeout:15000})
 assert.equal(submissions.length,1)
 const [{turnId,documentId,continuation}]=submissions
 assert.equal(documentId,file.fileId)
 assert.equal(continuation?.revision,file.revision,'PPTX delegation must checkpoint the clean saved revision')
 assert.ok(continuation.checkpoint.chatTurnId)
 await page.close()
 page=await context.newPage()
 await page.goto(documentUrl)
 panel=page.locator('.ai-panel');composer=panel.locator('textarea')
 rail=page.getByRole('button',{name:'展开 AI 助手',exact:true})
 const task=panel.locator(`.assistant-task-message[data-team-task="harness:${turnId}"]:visible`)
 await openAssistant()
 await expect(task.getByText('Computing PPTX total',{exact:true})).toBeVisible({timeout:15000})
 const draft='保留新页签中输入的草稿'
 await composer.fill(draft)
 release()
 await expect(task.getByText('Recovered total: 42',{exact:true})).toBeVisible({timeout:15000})
 await expect(panel.getByText(success,{exact:true})).toBeVisible({timeout:15000})
 await expect(panel.getByText(instruction,{exact:true})).toHaveCount(1)
 await expect(panel.getByText(success,{exact:true})).toHaveCount(1)
 await expect(composer).toHaveValue(draft)
 assert.equal(runs,1)
 assert.equal(submissions.length,1)
 assert.deepEqual(cancellations,[])
 assert.deepEqual(claims,['/api/v1/agents/tasks/'+turnId+'/continuation'])
 assert.equal(edits,1)
 const head=async()=>(await f.files.openFile(f.alice.token,file.fileId)).file.revision
 assert.equal(await head(),file.revision)
 await page.keyboard.press('Control+s')
 await expect.poll(head,{timeout:15000}).not.toBe(file.revision)
 const revision=await head()
 const zip=await JSZip.loadAsync(await f.files.readFile(f.alice.token,file.fileId,revision))
 assert.match(await zip.file('ppt/slides/slide1.xml').async('string'),new RegExp(revised))
 assert.deepEqual(await f.files.readFile(f.alice.token,file.fileId,file.revision),original)
 await page.reload()
 await openAssistant()
 await expect(panel.getByText(success,{exact:true})).toBeVisible()
 await expect(panel.getByText(instruction,{exact:true})).toHaveCount(1)
 assert.equal(await head(),revision)
 assert.equal(submissions.length,1)
 assert.equal(claims.length,1)
})
