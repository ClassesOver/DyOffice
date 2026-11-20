import {stubHomeHero} from '../helpers/home-hero.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {expect} from '@playwright/test'
import {backgroundDocumentBytes} from '../helpers/background-documents.mjs'
import {launchTestBrowser} from '../helpers/browser.mjs'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {password} from '../helpers/identity.mjs'
import {officeBrowserAsset} from '../helpers/office-browser-assets.mjs'
import {mockProviderNetwork} from '../helpers/provider-network.mjs'
import {buildLocalApp} from '../../server/src/app.ts'
import {realDshBackground} from '../helpers/real-dsh-background.mjs'
import {createGlobalConfigService} from '../../server/src/modules/admin/service.ts'

for(const format of ['docx','xlsx','pptx','pdf'])test('real homepage shares an empty channel and reads saved '+format+' after all browser contexts close',{timeout:600000},async t=>{
 const origin='http://localhost:4218',f=await fileFixture(t,{origin,worker:true}),keyring={activeKeyId:'browser-bg',keys:{'browser-bg':new Uint8Array(32).fill(37)}}
 const real=process.env.DYOFFICE_REAL_DSH==='on'?await realDshBackground(t):null
 const network=real?null:mockProviderNetwork(t,[Buffer.from('data: {"choices":[{"delta":{"content":"保存版本中的预算总额为42 CNY。"}}]}\n\ndata: [DONE]\n\n')])
 await createGlobalConfigService({transactions:f.transactions,keyring}).saveGlobalConfig(f.adminSigned.token,0,{upserts:[real?.entry??{id:'shared-chat',kind:'chat',providerId:'deepseek',label:'Shared model',model:'synthetic-model',baseUrl:'https://provider.example/v1',enabled:true,apiKey:'synthetic-key'}],defaults:{chat:'shared-chat'}})
 const app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,globalConfigKeyring:keyring,providerGateway:{mode:'shared'},codingHarnesses:false,assistantChannels:true,assistantBackground:{pool:f.workerPool},localShellDirectory:officeBrowserAsset('local-shell')})
 f.cleanup.push(()=>app.close());await app.listen({port:4218,host:'127.0.0.1'})
 const browser=await launchTestBrowser();t.after(()=>browser.close())
 const context=await browser.newContext({viewport:{width:1440,height:1000},permissions:['clipboard-read','clipboard-write']}),page=await context.newPage()
 await stubHomeHero(page)
 page.setDefaultTimeout(15000)
 let editorConnections=0
 page.on('request',r=>{if(/assistant-channels\/channels\/[^/]+\/connect$/.test(r.url()))editorConnections++})
 const login=async page=>{await page.goto(origin);await page.getByLabel('用户名',{exact:true}).fill('alice');await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.locator('.home')).toBeVisible()}
 await login(page)
 await page.getByRole('button',{name:/账号菜单/}).click()
 await page.getByRole('menuitem',{name:'频道分享',exact:true}).click()
 const created=page.waitForResponse(r=>r.url().endsWith('/assistant-channels/channels')&&r.request().method()==='POST')
 await page.getByRole('button',{name:'创建频道',exact:true}).click()
 const channel=await (await created).json();assert.equal(channel.fileId,null)
 const external=async(path,payload,token)=>{
  const reply=await fetch(origin+'/api/v1/assistant-channels'+path,{method:payload===undefined?'GET':'POST',headers:{...(payload===undefined?{}:{'content-type':'application/json'}),...(token?{authorization:'Bearer '+token}:{})},...(payload===undefined?{}:{body:JSON.stringify(payload)})})
  assert.equal(reply.status,200);return reply.json()
 }
 const file=(await importFile(f,f.alice.token,await backgroundDocumentBytes(format),'browser-budget.'+format)).file
 await page.getByRole('button',{name:'选择授权文档',exact:true}).click()
 const draft=page.getByRole('combobox',{name:'授权的文档'})
 await draft.selectOption(file.fileId)
 await page.waitForResponse(r=>r.request().method()==='GET'&&r.url().endsWith('/channels/'+channel.conversationId))
 await expect(draft).toHaveValue(file.fileId)
 await page.getByRole('button',{name:'允许后台读取已保存版本',exact:true}).click()
 await expect(page.getByRole('button',{name:'关闭后台读取',exact:true})).toBeVisible()
 await page.getByLabel('授权 Token 有效期').selectOption('43200')
 await page.getByRole('button',{name:'生成 DSH 授权 Token',exact:true}).click()
 const tokenField=page.getByLabel('DSH 授权 Token',{exact:true})
 await expect(tokenField).toBeVisible()
 const memberToken=await tokenField.inputValue()
 const issuedHistory=page.getByText('历史授权码（1）',{exact:true})
 await issuedHistory.click()
 await issuedHistory.click()
 await expect(page.locator('.background-token-history')).not.toHaveAttribute('open')
 await page.getByRole('button',{name:'复制授权 Token',exact:true}).click()
 await expect(page.getByRole('button',{name:'已复制授权 Token',exact:true})).toBeVisible()
 assert.ok(await page.evaluate(async token=>(await navigator.clipboard.readText())===token,memberToken))
 await page.getByRole('button',{name:'关闭频道分享',exact:true}).click()
 await page.getByRole('button',{name:/账号菜单/}).click()
 await page.getByRole('menuitem',{name:'频道分享',exact:true}).click()
 await page.getByRole('navigation',{name:'频道列表'}).getByRole('button',{name:new RegExp(channel.conversationId.slice(0,8))}).click()
 await expect(tokenField).toHaveCount(0)
 const history=page.locator('.background-token-history'),summary=history.getByText('历史授权码（1）',{exact:true})
 const reveal=history.getByRole('button',{name:'查看授权码',exact:true})
 const revealRoute='**/channels/*/members/*/dsh-token'
 let releaseReveal
 const pendingReveal=new Promise(resolve=>{releaseReveal=resolve})
 await page.route(revealRoute,async route=>{await pendingReveal;await route.continue()},{times:1})
 await summary.click()
 const revealRequested=page.waitForRequest(r=>/\/members\/[^/]+\/dsh-token$/.test(r.url()))
 try{
  await reveal.click()
  await revealRequested
  await summary.click()
  await expect(history).not.toHaveAttribute('open')
 }finally{releaseReveal()}
 await expect(page.getByRole('button',{name:'刷新',exact:true})).toBeEnabled()
 await expect(tokenField).toHaveCount(0)
 await summary.click()
 await page.setViewportSize({width:390,height:700})
 await reveal.click()
 await expect(history.getByLabel('DSH 授权 Token',{exact:true})).toBeInViewport()
 await expect(tokenField).toBeVisible()
 assert.ok((await tokenField.inputValue())===memberToken)
 await page.getByRole('button',{name:'刷新',exact:true}).click()
 await expect(page.getByRole('button',{name:'刷新',exact:true})).toBeEnabled()
 await expect(tokenField).toBeVisible()
 await page.getByRole('button',{name:'隐藏授权码',exact:true}).click()
 await expect(tokenField).toHaveCount(0)
 await expect(reveal).toBeFocused()
 await reveal.click()
 await expect(tokenField).toBeVisible()
 await page.getByRole('button',{name:'返回频道列表',exact:true}).click()
 await page.getByRole('navigation',{name:'频道列表'}).getByRole('button',{name:new RegExp(channel.conversationId.slice(0,8))}).click()
 await expect(tokenField).toHaveCount(0)
 await summary.click()
 await page.clock.install()
 await reveal.click()
 await expect(tokenField).toBeVisible()
 const expiry=Date.parse(await history.locator('.background-token-value time').getAttribute('datetime'))
 // Cross the browser's single-timer limit, then check both sides of the real deadline.
 await page.clock.fastForward(2_147_483_647)
 await expect(tokenField).toBeVisible()
 const remaining=expiry-await page.evaluate(()=>Date.now())
 await page.clock.fastForward(remaining-60_000)
 await expect(tokenField).toBeVisible()
 await page.clock.fastForward(61_000)
 await expect(tokenField).toHaveCount(0)
 await expect(history).toContainText('已过期')
 const member=real?null:await external('/member',undefined,memberToken)
 if(member)assert.equal(member.conversationId,channel.conversationId)
 assert.equal(editorConnections,0)
 await context.close();assert.equal(browser.contexts().length,0)
 let task
 if(real){
  task=await real.execute(origin+'/api/v1/assistant-channels',memberToken,format)
  assert.equal(task.state,'succeeded');assert.match(task.summary,/42/);assert.match(task.summary,/CNY|人民币|元/)
 }else{
  const memberPath='/members/'+member.member.membershipId
  const receipt=await external(memberPath+'/actions',{requestId:randomUUID(),conversationId:channel.conversationId,to:'office',action:{kind:'delegate',instruction:'预算总额是多少？',execution:'saved-revision'}},memberToken)
  await expect.poll(async()=>{task=await external(memberPath+'/tasks/'+receipt.taskId,undefined,memberToken);return task.state},{timeout:20000}).toBe('succeeded')
  assert.equal(network.writes,1);assert.match(JSON.stringify(JSON.parse(network.wire.toString())),/42 CNY/)
 }
 assert.equal(task.savedRevision,file.revision)
 const next=await browser.newContext({viewport:{width:1440,height:1000}}),reopened=await next.newPage()
 await stubHomeHero(reopened)
 await login(reopened)
 await reopened.getByRole('button',{name:/账号菜单/}).click()
 await reopened.getByRole('menuitem',{name:'后台任务',exact:true}).click()
 await reopened.getByRole('button',{name:'查看结果',exact:true}).click()
 await expect(reopened.getByText(task.summary,{exact:true})).toBeVisible()
 await expect(reopened.locator('.background-task-detail')).toContainText(file.revision)
 await reopened.getByRole('button',{name:'查看频道',exact:true}).click()
 await expect(reopened.locator('.background-columns article')).toContainText(channel.conversationId)
 await reopened.getByText('历史授权码（1）',{exact:true}).click()
 const reopenedHistory=reopened.locator('.background-token-history')
 await expect(reopenedHistory).toContainText('其他登录会话签发')
 await expect(reopenedHistory.getByRole('button',{name:'查看授权码',exact:true})).toHaveCount(0)
 await expect(reopened.getByLabel('DSH 授权 Token',{exact:true})).toHaveCount(0)
 await expect(reopened.getByRole('button',{name:'关闭后台读取',exact:true})).toBeVisible()
 await reopened.getByRole('button',{name:'暂停协作',exact:true}).click()
 await expect(reopened.getByRole('button',{name:'恢复协作',exact:true})).toBeVisible()
 await reopened.getByRole('button',{name:'移除连接',exact:true}).click()
 await expect(reopened.getByText('DSH DyOffice · 已移除',{exact:true})).toBeVisible()
 if(network)assert.equal(network.writes,1)
 else {
  const dispatches=await f.ownerPool.query('SELECT state FROM shared_provider_dispatches')
  assert.equal(dispatches.rowCount,1);assert.equal(dispatches.rows[0].state,'settled')
  t.diagnostic('Real DSH and real model verified task '+task.taskId+' at saved revision '+task.savedRevision)
 }
 await expect(reopenedHistory).toContainText('已撤销')
 await expect(reopened.getByRole('button',{name:'查看授权码',exact:true})).toHaveCount(0)
 await reopened.getByRole('button',{name:'删除频道',exact:true}).click()
 const confirm=reopened.getByRole('dialog',{name:'删除频道',exact:true})
 await expect(confirm).toContainText('源文档和保存版本会保留')
 await confirm.getByRole('button',{name:'取消',exact:true}).click()
 await expect(confirm).toBeHidden()
 await expect(reopened.locator('.background-columns article')).toContainText(channel.conversationId)
 await reopened.getByRole('button',{name:'删除频道',exact:true}).click()
 const removed=reopened.waitForResponse(response=>response.request().method()==='DELETE'&&response.url().endsWith('/channels/'+channel.conversationId))
 await confirm.getByRole('button',{name:'确认删除',exact:true}).click()
 assert.equal((await removed).status(),204)
 await expect(confirm).toBeHidden()
 await expect(reopened.getByRole('navigation',{name:'频道列表'}).getByRole('button',{name:new RegExp(channel.conversationId.slice(0,8))})).toHaveCount(0)
 assert.equal((await f.files.openFile(f.alice.token,file.fileId)).file.revision,file.revision)
 await next.close()
})
