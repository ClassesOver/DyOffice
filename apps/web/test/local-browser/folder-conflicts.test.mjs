import test from 'node:test'
import assert from 'node:assert/strict'
import {fileURLToPath} from 'node:url'
import {expect} from '@playwright/test'
import {launchTestBrowser} from '../helpers/browser.mjs'
import {fileFixture} from '../helpers/files.mjs'
import {password} from '../helpers/identity.mjs'
import {buildLocalApp} from '../../server/src/app.ts'

test('nested folders preserve identities through conflicts, rename and empty-only deletion',{timeout:120_000},async t=>{
 const origin='http://localhost:4208',f=await fileFixture(t,{origin})
 const app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,localShellDirectory:fileURLToPath(new URL('../../dist-local-shell',import.meta.url))})
 f.cleanup.push(()=>app.close());await app.listen({port:4208,host:'127.0.0.1'})
 const browser=await launchTestBrowser();t.after(()=>browser.close());const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),errors=[]
 page.on('pageerror',e=>errors.push(e.message))
 await page.goto(origin);await page.getByLabel('用户名',{exact:true}).fill('alice');await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.locator('.home')).toBeVisible()
 const tree=name=>page.locator('.tree-row').filter({has:page.locator('.tree-name').filter({hasText:new RegExp('^'+name+'$')})})
 const read=async()=>{const response=await context.request.get(origin+'/api/v1/workspace/folders');assert.equal(response.status(),200);return (await response.json()).folders}
 const create=async(name,status=201)=>{await page.locator('.folder-new-btn').click();const input=page.locator('.folder-rename-input.inline');await input.fill(name);const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/workspace/folders'&&r.request().method()==='POST');await input.press('Enter');assert.equal((await response).status(),status);return input}
 await create('Parent');await expect(tree('Parent')).toBeVisible();const parent=(await read()).find(x=>x.name==='Parent');assert.equal(parent.parentId,null)
 await tree('Parent').click();await create('Child');await expect(tree('Child')).toBeVisible();const child=(await read()).find(x=>x.name==='Child');assert.equal(child.parentId,parent.id)
 const duplicate=await create('Child',409);await expect(page.locator('.home')).toContainText('冲突');await expect(duplicate).toHaveValue('Child');assert.equal((await read()).length,2);await duplicate.press('Escape')
 await tree('Parent').locator('.folder-more-btn').click();await page.getByRole('menuitem',{name:'重命名',exact:true}).click()
 // During inline rename the tree-name span is replaced by the input.
 const rename=page.locator('.tree-row .folder-rename-input.inline');await rename.fill('Renamed Parent');const patched=page.waitForResponse(r=>r.url().endsWith('/workspace/folders/'+parent.id)&&r.request().method()==='PATCH');await rename.press('Enter');assert.equal((await patched).status(),200)
 await expect(tree('Renamed Parent')).toBeVisible();await expect(tree('Child')).toBeVisible();const after=await read();assert.equal(after.find(x=>x.id===child.id).parentId,parent.id);assert.equal(after.find(x=>x.id===parent.id).name,'Renamed Parent')
 const remove=async(name,status)=>{await tree(name).locator('.folder-more-btn').click();await page.getByRole('menuitem',{name:'删除文件夹…',exact:true}).click();const dialog=page.getByRole('dialog',{name:'删除文件夹？',exact:true});const result=page.waitForResponse(r=>new URL(r.url()).pathname.startsWith('/api/v1/workspace/folders/')&&r.request().method()==='DELETE');await dialog.getByRole('button',{name:'删除',exact:true}).click();assert.equal((await result).status(),status);return dialog}
 const rejected=await remove('Renamed Parent',409);await expect(rejected).toContainText('冲突');assert.equal((await read()).length,2);await rejected.locator(':scope > .modal-buttons').getByRole('button',{name:'取消',exact:true}).click()
 await remove('Child',204);await expect(tree('Child')).toHaveCount(0);await remove('Renamed Parent',204);await expect(tree('Renamed Parent')).toHaveCount(0);assert.deepEqual(await read(),[])
 assert.deepEqual(errors,[])
})
