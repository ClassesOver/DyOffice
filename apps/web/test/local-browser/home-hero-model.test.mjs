import test from 'node:test'
import assert from 'node:assert/strict'
import {Readable} from 'node:stream'
import {mkdir} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {expect} from '@playwright/test'
import {launchTestBrowser} from '../helpers/browser.mjs'
import {fileFixture,docxBytes,importFile} from '../helpers/files.mjs'
import {password} from '../helpers/identity.mjs'
import {mockProviderNetwork} from '../helpers/provider-network.mjs'
import {buildLocalApp} from '../../server/src/app.ts'
import {createGlobalConfigService} from '../../server/src/modules/admin/service.ts'
import {createWorkspaceService} from '../../server/src/modules/workspace/service.ts'

test('homepage model greeting uses the configured gateway, keeps multiline layout and falls back without blocking files',{timeout:120000},async t=>{
 const origin='http://localhost:4252',f=await fileFixture(t,{origin,buildApp:false}),keyring={activeKeyId:'hero',keys:{hero:new Uint8Array(32).fill(33)}}
 let app,browser
 t.after(async()=>{await browser?.close();app?.server.closeAllConnections();await app?.close()})
 const workspace=createWorkspaceService(f.transactions),bytes=await docxBytes()
 for(let index=1;index<=23;index++){
  const file=await importFile(f,f.alice.token,bytes,'hero-document-'+index+'.docx')
  await workspace.recordOpen(f.alice.token,file.file.fileId)
 }
 app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,globalConfigKeyring:keyring,providerGateway:{mode:'shared'},codingHarnesses:false,localShellDirectory:fileURLToPath(new URL('../../dist-local-shell',import.meta.url))})
 await app.listen({host:'127.0.0.1',port:4252});browser=await launchTestBrowser()
 const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[],turns=[]
 page.on('pageerror',error=>errors.push(error.message))
 page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname==='/api/v1/ai/turns')turns.push(request.postDataJSON())})
 await page.goto(origin);await page.getByLabel('用户名',{exact:true}).fill('alice');await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'登录',exact:true}).click()
 await expect(page.locator('.recent-row')).toHaveCount(20)
 await expect(page.locator('.hero-title')).toBeVisible();assert.equal(turns.length,0,'unconfigured models retain the original greeting without dispatch')
 const config=createGlobalConfigService({transactions:f.transactions,keyring})
 await config.saveGlobalConfig(f.adminSigned.token,0,{upserts:[{id:'hero-chat',kind:'chat',providerId:'deepseek',label:'Home model',model:'synthetic-hero',baseUrl:'https://provider.example/v1',enabled:true,apiKey:'synthetic-private-key'}],defaults:{chat:'hero-chat'}})
 const copy={greeting:'让每个好想法顺利落地。',guidance:'写一份新文档，或把手头的数据整理成清晰结论。'}
 let mode='valid'
 const upstream=mockProviderNetwork(t,()=>Readable.from([Buffer.from('data: '+JSON.stringify({choices:[{delta:{content:JSON.stringify(mode==='valid'?copy:{...copy,guidance:'过长'.repeat(100)})}}]})+'\n\ndata: [DONE]\n\n')]))
 await mkdir('test-results/home-hero-model',{recursive:true})
 for(const width of [1440,390]){
  await page.setViewportSize({width,height:900});await page.reload()
  await expect(page.locator('.hero-ask')).toHaveText(copy.guidance,{timeout:15000})
  const greeting=await page.locator('.hero-title').evaluate(node=>node.firstChild.textContent)
  assert.equal(greeting,copy.greeting)
  const heading=await page.locator('.hero-title').boundingBox(),guide=await page.locator('.hero-ask').boundingBox()
  assert.ok(guide.y>heading.y,'guidance remains below the greeting')
  assert.ok(await page.locator('.content').evaluate(node=>node.scrollHeight<=node.clientHeight+1),'generated hero does not introduce an outer scrollbar')
  await expect(page.getByRole('navigation',{name:'文件分页',exact:true})).toBeInViewport()
  await page.screenshot({path:`test-results/home-hero-model/generated-${width}.png`,animations:'disabled'})
 }
 assert.equal(turns.length,2,'one generation per mounted homepage')
 for(const turn of turns){assert.deepEqual(turn.request.tools,[]);assert.equal(turn.modelId,'hero-chat');assert.doesNotMatch(JSON.stringify(turn),/hero-document|synthetic-private-key/)}
 assert.equal(JSON.parse(upstream.wire).model,'synthetic-hero')
 mode='invalid';await page.reload();await expect(page.locator('.recent-row')).toHaveCount(20)
 await expect.poll(()=>upstream.writes).toBe(3)
 await expect(page.locator('.hero-ask')).not.toHaveText(copy.guidance)
 await page.route('**/api/v1/ai/turns',route=>route.fulfill({status:503,contentType:'application/json',body:'{"error":"Unavailable"}'}))
 await page.reload();await expect(page.locator('.recent-row')).toHaveCount(20)
 await expect(page.locator('.hero-title')).toBeVisible()
 await expect(page.locator('.hero-ask')).not.toHaveText(copy.guidance)
 await page.screenshot({path:'test-results/home-hero-model/fallback-390.png',animations:'disabled'})
 assert.deepEqual(errors,[])
})
