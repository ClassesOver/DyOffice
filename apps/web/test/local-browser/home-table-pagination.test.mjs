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

test('home tables keep headers visible and paginate recent, starred and folder files',{timeout:180000},async t=>{
 const origin='http://localhost:4225',f=await fileFixture(t,{origin}),workspace=createWorkspaceService(f.transactions),bytes=await docxBytes()
 for(let index=1;index<=23;index++){
  const imported=await importFile(f,f.adminSigned.token,bytes,`分页文档${String(index).padStart(2,'0')}.docx`)
  await workspace.recordOpen(f.adminSigned.token,imported.file.fileId)
  await workspace.setStar(f.adminSigned.token,imported.file.fileId,{starred:true})
 }
 const app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,localShellDirectory:fileURLToPath(new URL('../../dist-local-shell',import.meta.url))})
 f.cleanup.push(()=>app.close());await app.listen({port:4225,host:'127.0.0.1'})
 const browser=await launchTestBrowser();t.after(()=>browser.close());const page=await browser.newPage(),errors=[],requests=[]
 page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{const url=new URL(request.url());if(url.pathname==='/api/v1/workspace/files')requests.push(url.searchParams)})
 await mkdir('test-results/home-table-pagination',{recursive:true})
 await page.goto(origin);await page.getByLabel('用户名',{exact:true}).fill('owner');await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'登录',exact:true}).click()
 const pager=page.getByRole('navigation',{name:'文件分页',exact:true}),next=pager.getByRole('button',{name:'下一页',exact:true}),previous=pager.getByRole('button',{name:'上一页',exact:true})
 for(const width of [1440,390]){
  await page.setViewportSize({width,height:900});await page.evaluate(()=>document.documentElement.dataset.theme='light')
  await page.locator('.sidebar-nav').getByRole('button',{name:/最近/}).click()
  await expect(page.locator('.recent-row')).toHaveCount(20);await expect(pager).toContainText('第 1 / 2 页');await expect(previous).toBeDisabled()
  assert.ok(await page.locator('.content').evaluate(node=>node.scrollHeight<=node.clientHeight+1),'hero and file table fit the page without an outer vertical scrollbar')
  await expect(pager).toBeInViewport()
  assert.ok(requests.some(params=>params.get('view')==='recent'&&params.get('limit')==='20'))
  const header=page.locator('.recent-columns'),table=page.locator('.recent-table')
  await table.scrollIntoViewIfNeeded();const initial=await header.boundingBox()
  await table.evaluate(node=>node.scrollTop=300)
  await expect.poll(()=>table.evaluate(node=>node.scrollTop)).toBeGreaterThan(200)
  const scrolled=await header.boundingBox();assert.ok(Math.abs(initial.y-scrolled.y)<=1,'table header remains fixed during row scroll')
  await page.screenshot({animations:'disabled',path:`test-results/home-table-pagination/sticky-${width}.png`})
  await page.getByRole('checkbox',{name:'全选',exact:true}).check();await expect(page.locator('.selection-count')).toContainText('20')
  await next.click();await expect(page.locator('.recent-row')).toHaveCount(3);await expect(pager).toContainText('第 2 / 2 页');await expect(next).toBeDisabled()
  await expect(page.locator('.selection-count')).toHaveCount(0);assert.equal(await table.evaluate(node=>node.scrollTop),0)
  assert.ok(requests.some(params=>params.get('view')==='recent'&&params.get('offset')==='20'&&params.get('limit')==='20'))
  await pager.scrollIntoViewIfNeeded()
  const pagerBox=await pager.boundingBox();assert.ok(pagerBox.x>=0&&pagerBox.x+pagerBox.width<=width+1,'pagination stays within the viewport')
  await page.screenshot({animations:'disabled',path:`test-results/home-table-pagination/page-two-${width}.png`})
  await page.getByRole('tablist',{name:'按类型筛选',exact:true}).getByRole('button',{name:'文档',exact:true}).click()
  await expect(page.locator('.recent-row')).toHaveCount(20);await expect(pager).toContainText('第 1 / 2 页')
  await next.click();await expect(page.locator('.recent-row')).toHaveCount(3)
  const target=await page.locator('.recent-name').first().textContent()
  await page.locator('.recent-item .more-btn').first().click();await page.getByRole('menuitem',{name:'打开所在文件夹',exact:true}).click()
  await expect(page.locator('.recent-row').filter({hasText:target}).locator('.row-check')).toBeChecked()
  await page.locator('.tree-name').filter({hasText:/^个人文件$/}).click()
  await expect(page.locator('.recent-row')).toHaveCount(20)
  await next.click();await expect(page.locator('.recent-row')).toHaveCount(3)
  await page.getByRole('checkbox',{name:'全选',exact:true}).check();await expect(page.locator('.selection-count')).toContainText('3')
  await previous.click();await expect(page.locator('.recent-row')).toHaveCount(20);await expect(page.locator('.selection-count')).toHaveCount(0)
  await page.locator('.sidebar-nav').getByRole('button',{name:/收藏/}).click();await expect(page.locator('.recent-row')).toHaveCount(20)
  await next.click();await expect(page.locator('.recent-row')).toHaveCount(3);await expect(pager).toContainText('第 2 / 2 页')
  await page.evaluate(()=>document.documentElement.dataset.theme='dark');await page.screenshot({animations:'disabled',path:`test-results/home-table-pagination/starred-dark-${width}.png`})
 }
 assert.deepEqual(errors,[])
})
