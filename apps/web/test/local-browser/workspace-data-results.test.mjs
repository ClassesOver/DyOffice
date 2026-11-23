import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomBytes,randomUUID} from 'node:crypto'
import {expect} from '@playwright/test'
import {launchTestBrowser} from '../helpers/browser.mjs'
import {docxBytes,fileFixture,importFile} from '../helpers/files.mjs'
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

 const fileA=(await importFile(f,token,await docxBytes(),'甲文档.docx')).file
 const fileB=(await importFile(f,token,await docxBytes(),'乙文档.docx')).file
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
 const actions=row.locator('.dr-row-actions > summary')
 await expect(row.getByRole('button',{name:'下载 JSON'})).toBeHidden()
 await actions.focus()
 await page.keyboard.press('Enter')
 await expect(row.getByRole('button',{name:'下载 JSON'})).toBeVisible()
 page.once('dialog',confirm=>confirm.accept())
 await dialog.getByRole('button',{name:'删除结果 旧报表',exact:true}).click()
 await expect(dialog.getByRole('status')).toContainText('释放了工作区存储空间')
 await expect(dialog.getByRole('button',{name:'旧报表',exact:true})).toHaveCount(0)
 assert.equal((await results.list(token)).items.length,0)
 assert.equal((await results.save(token,save)).state,'saved')
 await dialog.getByRole('button',{name:'关闭数据结果'}).click()
 await page.setViewportSize({width:1280,height:850})
 const session=(await page.context().cookies(origin)).find(cookie=>cookie.name==='__Host-dyoffice-session')
 assert.ok(session)
 const draft=await results.capture(session.value,snapshot,queryHash,fileA.fileId)
 for(const [file,name] of [[fileA,'甲文档.docx'],[fileB,'乙文档.docx']]){
  await page.evaluate(id=>{location.hash='/file/'+id},file.fileId)
  await page.getByRole('tab',{name,exact:true}).click({button:'right'})
  await page.getByRole('menuitem',{name:'文档数据结果',exact:true}).click()
  const scoped=page.getByRole('dialog',{name:'文档数据结果 · '+name,exact:true})
  if(file===fileA){
   const pending=scoped.getByRole('listitem').filter({has:page.getByRole('button',{name:'保存结果',exact:true})})
   await pending.getByRole('button',{expanded:false}).first().click()
   await expect(pending.getByRole('cell',{name:'42',exact:true})).toBeVisible()
   const nameInput=pending.getByRole('textbox',{name:'名称',exact:true})
   await nameInput.fill('Q1/Q2')
   await pending.getByRole('button',{name:'保存结果',exact:true}).click()
   await expect(nameInput).toBeFocused()
   assert.equal(await nameInput.evaluate(input=>input.validity.customError),true)
   await nameInput.fill('甲专用报表')
   await pending.getByRole('button',{name:'保存结果',exact:true}).click()
   await expect(scoped.getByRole('button',{name:'甲专用报表'})).toBeFocused()
   await expect(scoped.getByRole('status')).toContainText('已保存「甲专用报表」')
   await scoped.getByRole('button',{name:'刷新列表'}).click()
   assert.ok((await results.list(token,{},fileA.fileId)).items.some(item=>item.resultId===draft.resultId && item.name==='甲专用报表'))
   await expect(scoped.getByRole('cell',{name:'42',exact:true})).toBeVisible()
  }else{
   await expect(scoped.getByText('暂无已保存的数据结果。')).toBeVisible()
   await expect(scoped.getByRole('button',{name:'甲专用报表'})).toHaveCount(0)
  }
  await expect(scoped.getByRole('button',{name:'新报表'})).toHaveCount(0)
  await scoped.getByRole('button',{name:'关闭文档数据结果 · '+name}).click()
 }

})
