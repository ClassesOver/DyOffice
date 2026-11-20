import test from 'node:test'
import assert from 'node:assert/strict'
import {Readable} from 'node:stream'
import {expect} from '@playwright/test'
import JSZip from 'jszip'
import {buildLocalApp} from '../../server/src/app.ts'
import {createGlobalConfigService} from '../../server/src/modules/admin/service.ts'
import {launchTestBrowser} from '../helpers/browser.mjs'
import {docxBytes,fileFixture,importFile} from '../helpers/files.mjs'
import {password} from '../helpers/identity.mjs'
import {mockProviderNetwork} from '../helpers/provider-network.mjs'

const nativeDocsDirectory=process.env.DYOFFICE_TEST_NATIVE_DOCS_DIST
test('Word refresh resumes the original Harness turn and edits the document once',{skip:!nativeDocsDirectory,timeout:90000},async t=>{
  const origin='http://localhost:4261',f=await fileFixture(t,{origin,buildApp:false})
  await f.preferences.update(f.alice.token,{language:'en',autoSave:false,showAssistant:true})
  const original=await docxBytes(),{file}=await importFile(f,f.alice.token,original,'recover-task.docx')
  const keyring={activeKeyId:'docx-recovery',keys:{'docx-recovery':new Uint8Array(32).fill(42)}}
  await createGlobalConfigService({transactions:f.transactions,keyring}).saveGlobalConfig(f.adminSigned.token,0,{
    upserts:[{id:'fixture',kind:'chat',providerId:'openai',label:'Fixture',model:'synthetic',baseUrl:'https://provider.example/v1',apiKey:'fixture-key',enabled:true}],
    defaults:{chat:'fixture'},
  })
  let runs=0,release
  const gate=new Promise(resolve=>{release=resolve})
  const app=await buildLocalApp({
    db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,
    globalConfigKeyring:keyring,providerGateway:{mode:'shared'},nativeDocsDirectory,
    codingHarnesses:{defaultId:'fixture-calc',adapters:[{
      descriptor:{id:'fixture-calc',name:'Calculator',capabilities:['coding'],origin:'external'},
      async run(_input,signal,context){
        runs++
        context.onProgress({kind:'status',text:'Computing fixture total'})
        await gate
        signal.throwIfAborted()
        return {summary:'Recovered total: 42',output:'42'}
      },
    }]},
  })
  f.cleanup.unshift(async()=>{release();await app.close()})
  await app.listen({port:4261,host:'127.0.0.1'})
  const browser=await launchTestBrowser()
  f.cleanup.unshift(()=>browser.close())
  const page=await browser.newPage({viewport:{width:1360,height:900}})
  const {csrfToken}=await (await page.request.get(origin+'/api/v1/auth/csrf')).json()
  assert.equal((await page.request.post(origin+'/api/v1/auth/login',{
    headers:{origin,'x-csrf-token':csrfToken},data:{username:'alice',password},
  })).status(),200)
  const instruction='Calculate the total and insert the result in Word.'
  const revised='Word Harness fixture total: 42',reply='The calculated total was inserted into the Word draft.'
  let editCalls=0
  const network=mockProviderNetwork(t,()=>{try{
    const {tools,messages}=JSON.parse(network.wire.toString())
    const delegated=messages.find(message=>message.role==='tool'&&message.tool_call_id==='recover-fixture')
    const edited=messages.find(message=>message.role==='tool'&&message.tool_call_id==='recover-edit')
    const call=(id,name,input)=>({tool_calls:[{index:0,id,type:'function',function:{name,arguments:JSON.stringify(input)}}]})
    let delta
    if(edited){
      assert.match(edited.content,/Inserted 1 block/)
      delta={content:reply}
    }else if(delegated){
      assert.ok(!tools.some(tool=>tool.function.name==='delegate_agent_task'))
      assert.match(delegated.content,/Recovered total: 42/)
      assert.equal(++editCalls,1)
      delta=call('recover-edit','insert_content',{html:'<p>'+revised+'</p>',afterBlockIndex:-1})
    }else delta=call('recover-fixture','delegate_agent_task',{instruction:'Calculate the fixture total'})
    return Readable.from([Buffer.from('data: '+JSON.stringify({choices:[{delta,finish_reason:delta.tool_calls?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n')])
  }catch(error){t.diagnostic(error.stack);throw error}})
  const submissions=[],cancellations=[],claims=[]
  page.on('request',request=>{
    const path=new URL(request.url()).pathname
    if(request.method()==='POST'&&path==='/api/v1/agents/tasks')submissions.push(request.postDataJSON())
    if(path.startsWith('/api/v1/agents/tasks/')&&path.endsWith('/cancel'))cancellations.push(path)
    if(path.startsWith('/api/v1/agents/tasks/')&&path.endsWith('/continuation'))claims.push(path)
  })
  const editor=page.locator('.tiptap.doc-page[contenteditable="true"]').first()
  const assistant=page.locator('.ai-panel')
  async function showAssistant(){
    await expect(editor).toBeVisible({timeout:20000})
    if(await page.locator('.ai-rail').isVisible())await page.locator('.ai-rail').click()
    await expect(assistant).toBeVisible()
  }
  await page.goto(origin+'/native-docx/?fileId='+file.fileId)
  await showAssistant()
  await assistant.locator('textarea').fill(instruction)
  await assistant.locator('textarea').press('Enter')
  await expect(assistant.locator('.assistant-task-message:visible').getByText('Computing fixture total',{exact:true})).toBeVisible({timeout:15000})
  assert.equal(submissions.length,1)
  assert.equal(submissions[0].documentId,file.fileId)
  assert.equal(submissions[0].continuation.revision,file.revision)
  const {turnId}=submissions[0]
  const task=assistant.locator(`.assistant-task-message[data-team-task="harness:${turnId}"]:visible`)
  await page.reload()
  await showAssistant()
  await expect(task.getByText('Computing fixture total',{exact:true})).toBeVisible({timeout:15000})
  release()
  await expect(assistant.locator('.ai-msg-assistant[dir="auto"]').getByText(reply,{exact:true})).toBeVisible({timeout:15000})
  await expect(assistant.getByText(reply,{exact:true})).toHaveCount(1)
  await expect(assistant.getByText(instruction,{exact:true})).toHaveCount(1)
  await expect(editor.getByText(revised,{exact:true})).toHaveCount(1)
  assert.equal((await f.files.openFile(f.alice.token,file.fileId)).file.revision,file.revision)
  assert.equal(runs,1)
  assert.equal(editCalls,1)
  assert.equal(submissions.length,1)
  assert.deepEqual(cancellations,[])
  assert.deepEqual(claims,['/api/v1/agents/tasks/'+turnId+'/continuation'])
  await page.keyboard.press('Control+s')
  await expect(page.locator('.dyoffice-docs-persistence-state')).toHaveAttribute('data-native-save','accepted',{timeout:15000})
  const revision=(await f.files.openFile(f.alice.token,file.fileId)).file.revision
  assert.notEqual(revision,file.revision)
  const saved=await JSZip.loadAsync(await f.files.readFile(f.alice.token,file.fileId,revision))
  assert.equal((await saved.file('word/document.xml').async('string')).split(revised).length,2)
  assert.deepEqual(await f.files.readFile(f.alice.token,file.fileId,file.revision),original)
  await page.reload()
  await showAssistant()
  await expect(assistant.getByText(reply,{exact:true})).toBeVisible()
  await expect(assistant.getByText(instruction,{exact:true})).toHaveCount(1)
  assert.equal(claims.length,1)
})
