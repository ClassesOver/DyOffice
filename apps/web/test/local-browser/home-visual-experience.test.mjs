import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdir} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {expect} from '@playwright/test'
import {launchTestBrowser} from '../helpers/browser.mjs'
import {fileFixture,docxBytes,importFile} from '../helpers/files.mjs'
import {password} from '../helpers/identity.mjs'
import {buildLocalApp} from '../../server/src/app.ts'
import {createWorkspaceService} from '../../server/src/modules/workspace/service.ts'

test('home keeps files and actions usable across viewport sizes and themes',{timeout:180000},async t=>{
 const origin='http://localhost:4224',f=await fileFixture(t,{origin})
 const workspace=createWorkspaceService(f.transactions),bytes=await docxBytes()
 for(const name of ['季度经营复盘.docx','项目协作与交付计划.docx','这是一份用于检查窄屏文件名截断与操作按钮对齐的长名称文档.docx']){
  const imported=await importFile(f,f.adminSigned.token,bytes,name)
  await workspace.recordOpen(f.adminSigned.token,imported.file.fileId)
 }
 const app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,localShellDirectory:fileURLToPath(new URL('../../dist-local-shell',import.meta.url))})
 f.cleanup.push(()=>app.close());await app.listen({port:4224,host:'127.0.0.1'})
 const browser=await launchTestBrowser();t.after(()=>browser.close())
 const page=await browser.newPage(),errors=[];page.setDefaultTimeout(12000)
 page.on('pageerror',error=>errors.push(error.message))
 const directory='test-results/home-visual-experience';await mkdir(directory,{recursive:true})
 const capture=async(name,width)=>{
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+' page overflow')
  assert.ok(await page.locator('.content').evaluate(node=>node.scrollWidth<=node.clientWidth+1),name+' content overflow')
  await page.screenshot({animations:'disabled',path:`${directory}/${name}-${width}.png`})
 }
 await page.goto(origin);await page.getByLabel('用户名',{exact:true}).fill('owner');await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'登录',exact:true}).click()
 await expect(page.locator('.recent-row')).toHaveCount(3)
 for(const width of [1440,1024,768,390,320]){
  await page.setViewportSize({width,height:900})
  const quickCard=page.locator('.quick-card').first(),cardBox=await quickCard.boundingBox()
  const badgeBox=await quickCard.locator(':scope > :first-child').boundingBox(),copyBox=await quickCard.locator('.quick-text').boundingBox()
  assert.ok(cardBox.height<=100,'compact quick actions leave more room for files')
  assert.ok(copyBox.x>=badgeBox.x+badgeBox.width,'quick action labels sit beside the format badge')
  const content=await page.locator('.content').boundingBox()
  if(width===768||width===1024){
   const cards=await page.locator('.quick-card').all(),first=await cards[0].boundingBox()
   for(const card of cards)assert.ok(Math.abs((await card.boundingBox()).y-first.y)<=1,'tablet shortcuts stay on one row')
  }
  if(width<=680){
   assert.ok(content.width>=width-1,'mobile files use the full viewport width')
   const name=await page.locator('.recent-name').first().boundingBox()
   assert.ok(name.width>=120,'mobile filename keeps a readable width')
   assert.ok(await page.locator('.account-name').evaluate(node=>node.scrollWidth<=node.clientWidth),'workspace title is not clipped')
   const upload=page.locator('.quick-card').last()
   await upload.focus();await expect(upload).toBeInViewport()
   await capture('quick-actions',width)
   await page.locator('.quick-card').first().scrollIntoViewIfNeeded()
  }
  if(width===1440){
   const cards=await page.locator('.quick-cards').boundingBox(),last=await page.locator('.quick-card').last().boundingBox()
   assert.ok(Math.abs(last.x+last.width-cards.x-cards.width)<=1,'quick cards fill their desktop grid')
  }
  for(const theme of ['light','dark']){
   await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme)
   await capture(theme+'-files',width)
   const row=page.locator('.recent-item').filter({hasText:'季度经营复盘.docx'})
   await row.locator('.row-check').check();await expect(page.locator('.selection-count')).toContainText('1')
   const selectAll=page.getByRole('checkbox',{name:'全选',exact:true})
   await expect(selectAll).toHaveJSProperty('indeterminate',true)
   await expect(selectAll).toHaveAttribute('aria-checked','mixed')
   await selectAll.focus()
   if(width<=680){
    const buttons=await page.locator('.selection-bar .selection-action').all(),boxes=await Promise.all(buttons.map(button=>button.boundingBox()))
    assert.ok(boxes.every(box=>box.height>=38),'mobile bulk actions have comfortable click targets')
    assert.ok(Math.abs(boxes[0].width-boxes[1].width)<=1&&Math.abs(boxes[0].y-boxes[1].y)<=1,'mobile bulk actions align in equal columns')
   }
   await capture(theme+'-selected',width)
   await page.locator('.selection-bar').getByRole('button',{name:'取消',exact:true}).click()
   const more=row.locator('.more-btn')
   await more.focus();await page.keyboard.press('Enter')
   const fileMenu=page.locator('.row-menu.home-web-menu')
   await expect(fileMenu).toBeVisible()
   const menuBox=await fileMenu.boundingBox()
   assert.ok(menuBox.x>=0&&menuBox.x+menuBox.width<=width+1&&menuBox.y>=0&&menuBox.y+menuBox.height<=900,'file menu stays within the viewport')
   const items=fileMenu.getByRole('menuitem')
   await expect(items.first()).toBeFocused()
   await page.keyboard.press('ArrowDown');await expect(items.nth(1)).toBeFocused()
   await capture(theme+'-file-menu',width)
   await page.keyboard.press('Escape');await expect(fileMenu).toHaveCount(0);await expect(more).toBeFocused()
   if([1440,390,320].includes(width)){
    for(const action of ['删除文件','移动到文件夹']){
     await more.click();await page.locator('.row-menu').getByRole('menuitem',{name:new RegExp('^'+action)}).click()
     const dialog=page.getByRole('dialog'),box=await dialog.boundingBox()
     assert.ok(box.x>=16&&box.x+box.width<=width-15&&box.y>=16&&box.y+box.height<=885,'file dialog fits within the viewport')
     assert.ok(await dialog.evaluate(node=>node.scrollWidth<=node.clientWidth+1),'file dialog has no horizontal overflow')
     await expect(dialog.getByRole('button',{name:'取消',exact:true})).toBeVisible()
     if(action==='删除文件'){
      await expect(dialog.getByRole('button',{name:'取消',exact:true})).toBeFocused()
      await page.keyboard.press('Shift+Tab');await expect(dialog.locator('.btn-danger')).toBeFocused()
      await page.keyboard.press('Tab');await expect(dialog.getByRole('button',{name:'取消',exact:true})).toBeFocused()
     }else await expect(dialog.locator('.picker-search')).toBeFocused()
     await capture(theme+(action==='删除文件'?'-delete-dialog':'-move-dialog'),width)
     await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);await expect(more).toBeFocused()
     await expect(page.locator('.recent-row')).toHaveCount(3)
    }
   }
   await page.locator('.account-btn').click();await expect(page.getByRole('menuitem',{name:'个人设置',exact:true})).toBeVisible()
   const menu=await page.locator('.account-menu-popover').boundingBox()
   assert.ok(menu.y>=12&&menu.y+menu.height<=page.viewportSize().height-11,'account popup stays inside the viewport')
   assert.ok(menu.height>=300,'account popup has usable space for its actions')
   if(width<=680){const trigger=await page.locator('.account-btn').boundingBox();assert.ok(menu.y>=trigger.y+trigger.height,'top account entry opens downward')}
   await capture(theme+'-account-menu',width);await page.keyboard.press('Escape');await expect(page.locator('.account-btn')).toBeFocused()
  }
  const filters=page.getByRole('tablist',{name:'按类型筛选',exact:true})
  await filters.getByRole('button',{name:'PDF',exact:true}).click();await expect(page.locator('.proj-empty')).toBeVisible()
  await capture('filtered-empty',width)
  await filters.getByRole('button',{name:'全部',exact:true}).click();await expect(page.locator('.recent-row')).toHaveCount(3)
  const search=page.locator('.file-search input')
  await search.fill('季度经营');await expect(page.locator('.search-row')).toHaveCount(1)
  const resultName=await page.locator('.search-name').boundingBox(),resultPath=await page.locator('.search-path').boundingBox()
  assert.ok(resultPath.y>=resultName.y+resultName.height,'search location sits below its filename')
  await page.keyboard.press('Tab');await page.locator('.search-row').first().focus();await expect(page.locator('.search-row').first()).toBeFocused()
  await capture('search',width)
  await page.locator('.file-search-clear').click();await expect(search).toHaveValue('');await expect(search).toBeFocused()
  await expect(page.locator('.recent-row')).toHaveCount(3)
  await search.fill('no-matching-file-pixel-review');await expect(page.locator('.search-results .proj-empty')).toBeVisible();await capture('search-empty',width)
  await search.press('Escape');await expect(search).toHaveValue('')
 }
 await page.setViewportSize({width:390,height:568})
 await page.locator('.account-btn').click()
 const shortMenu=page.locator('.account-menu-popover')
 await page.getByRole('menuitem',{name:'退出登录',exact:true}).scrollIntoViewIfNeeded()
 await expect(page.getByRole('menuitem',{name:'退出登录',exact:true})).toBeInViewport()
 const shortBox=await shortMenu.boundingBox()
 assert.ok(shortBox.y>=12&&shortBox.y+shortBox.height<=557,'short-screen account menu remains bounded')
 await capture('short-account-menu',390);await page.keyboard.press('Escape')
 await page.locator('.recent-item .more-btn').first().click()
 await page.locator('.row-menu').getByRole('menuitem',{name:/^移动到文件夹/}).click()
 const shortDialog=page.getByRole('dialog')
 await shortDialog.getByRole('button',{name:'取消',exact:true}).scrollIntoViewIfNeeded()
 await expect(shortDialog.getByRole('button',{name:'取消',exact:true})).toBeInViewport()
 assert.ok(await shortDialog.evaluate(node=>node.getBoundingClientRect().height<=innerHeight-32),'short-screen file picker is bounded')
 await capture('short-move-dialog',390);await page.keyboard.press('Escape')
 await page.setViewportSize({width:390,height:844})
 const row=page.locator('.recent-item').filter({hasText:'季度经营复盘.docx'})
 await row.getByRole('button',{name:'收藏',exact:true}).click();await expect(row.getByRole('button',{name:'取消收藏',exact:true})).toBeVisible()
 await page.locator('.sidebar-nav').getByRole('button',{name:/收藏/}).click();await expect(page.locator('.recent-row')).toHaveCount(1)
 await capture('starred',390)
 await page.locator('.tree-name').filter({hasText:/^个人文件$/}).click();await expect(page.locator('.recent-row')).toHaveCount(3)
 await capture('folder',390)
 assert.deepEqual(errors,[])
})
