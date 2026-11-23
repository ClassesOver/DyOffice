import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomBytes,randomUUID} from 'node:crypto'
import {expect} from '@playwright/test'
import {launchTestBrowser} from '../helpers/browser.mjs'
import {fileFixture} from '../helpers/files.mjs'
import {stubHomeHero} from '../helpers/home-hero.mjs'
import {password} from '../helpers/identity.mjs'
import {officeBrowserAsset} from '../helpers/office-browser-assets.mjs'
import {buildLocalApp} from '../../server/src/app.ts'
import {createSourceService} from '../../server/src/modules/sources/service.ts'
import {createWorkspaceSourceResults} from '../../server/src/modules/sources/results.ts'
import {createQuerySnapshot} from '../../server/src/modules/sources/provenance.ts'

test('the Home data results menu lets a personal user manage saved data results',{timeout:90000},async t=>{
 const origin='http://localhost:4229'
 const credentialKeys='test:'+randomBytes(32).toString('base64')
 const f=await fileFixture(t,{origin,sourcesCredentialKeys:credentialKeys})
 const sources=createSourceService({transactions:f.transactions,credentialKeys})
 const results=createWorkspaceSourceResults({transactions:f.transactions})
 const token=f.alice.token
 await sources.create(token,{sourceId:'metrics',name:'Metrics',kind:'postgres',config:{},secret:'postgresql://reader:fixture@db.example/reporting'})
 const queryHash=createHash('sha256').update('saved results fixture').digest('hex')
 const snapshot=createQuerySnapshot({sourceId:'metrics',sourceVersion:1,timezone:'UTC',schema:[{name:'类别',type:'string'},{name:'合计',type:'number'}],rows:[{'类别':'订阅收入','合计':42},{'类别':'服务收入','合计':1250}],sourceTruncated:false})
 const first=await results.capture(token,snapshot,queryHash)
 await results.save(token,{resultId:first.resultId,name:'旧报表',commandId:randomUUID()})
 const second=await results.capture(token,snapshot,queryHash)
 const save={resultId:second.resultId,name:'新报表',commandId:randomUUID()}

 const app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,sourcesCredentialKeys:credentialKeys,localShellDirectory:officeBrowserAsset('local-shell')})
 f.cleanup.push(()=>app.close())
 await app.listen({port:4229,host:'127.0.0.1'})
 const browser=await launchTestBrowser();t.after(()=>browser.close())
 const page=await browser.newPage({viewport:{width:390,height:700}})
 await stubHomeHero(page)
 await page.goto(origin)
 await page.getByLabel('用户名',{exact:true}).fill('alice')
 await page.getByLabel('密码',{exact:true}).fill(password)
 await page.getByRole('button',{name:'登录',exact:true}).click()
 await page.getByRole('button',{name:/账号菜单/}).click()
 await page.getByRole('menuitem',{name:'数据结果',exact:true}).click()
 const dialog=page.getByRole('dialog',{name:'数据结果',exact:true})
 const report=dialog.getByRole('button',{name:'旧报表',exact:true})
 const search=dialog.getByRole('searchbox')
 await search.fill(' METRICS ')
 await expect(report).toBeVisible()
 await search.fill('no match')
 await expect(report).toHaveCount(0)
 await expect(dialog.locator('output')).toHaveText('0 / 1')
 await dialog.getByRole('button',{name:'清除筛选'}).click()
 await expect(search).toBeFocused()
 await search.fill('旧报')
 await report.click()
 const row=dialog.getByRole('listitem').filter({has:page.getByRole('button',{name:'旧报表',exact:true})})
 await expect(row.locator('time')).toHaveAttribute('datetime',/.+/)
 await expect(row.getByRole('cell',{name:'42',exact:true})).toBeVisible()
 await expect(row.getByRole('cell',{name:'1250',exact:true})).toHaveCSS('text-align','end')
 await expect(row.getByRole('cell',{name:'服务收入',exact:true})).toHaveCSS('white-space','normal')
 const checksum=row.locator('details').filter({has:page.getByText('SHA-256',{exact:true})})
 await expect(checksum.locator('code')).toBeHidden()
 await checksum.locator('summary').click()
 await expect(checksum.locator('code')).toHaveText(snapshot.sha256)
 assert.ok(await row.evaluate(element=>element.scrollWidth<=element.clientWidth+1))
 await report.click()
 await expect(row.getByRole('table')).toHaveCount(0)
 page.once('dialog',confirm=>confirm.accept())
 await dialog.getByRole('button',{name:'删除结果 旧报表',exact:true}).click()
 await expect(dialog.getByRole('status')).toContainText('释放了工作区存储空间')
 await expect(dialog.getByRole('button',{name:'旧报表',exact:true})).toHaveCount(0)
 assert.equal((await results.list(token)).items.length,0)
 assert.equal((await results.save(token,save)).state,'saved')
})
