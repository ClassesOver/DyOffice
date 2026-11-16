import test from 'node:test'
import assert from 'node:assert/strict'
import {fileURLToPath} from 'node:url'
import {mkdir} from 'node:fs/promises'
import {chromium,expect} from '@playwright/test'
import {fileFixture,docxBytes,importFile} from '../helpers/files.mjs'
import {password} from '../helpers/identity.mjs'
import {buildLocalApp} from '../../server/src/app.ts'
// Real PostgreSQL + HttpOnly session cookies + actual original Home/Settings UI.
// No routed/mocked APIs and no development token injection.
test('local original shell logs in, saves personal settings, isolates accounts and logs out', {timeout:120_000},async t=>{
 const origin='http://localhost:4199'
 const f=await fileFixture(t,{origin})
 await importFile(f,f.alice.token,await docxBytes(),'alice-private.docx')
 const app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,localShellDirectory:fileURLToPath(new URL('../../dist-local-shell',import.meta.url))})
 f.cleanup.push(()=>app.close());await app.listen({port:4199,host:'127.0.0.1'})
 const browser=await chromium.launch();t.after(()=>browser.close());const page=await browser.newPage({viewport:{width:1440,height:1000}})
 const errors=[];page.on('pageerror',error=>errors.push(error.message))
 const login=async name=>{await page.getByLabel('用户名',{exact:true}).fill(name);await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.locator('.home')).toBeVisible()}
 await page.goto(origin);await login('alice');await expect(page.getByText('alice-private.docx',{exact:true})).toBeVisible()
 const newButtons=page.locator('.quick-card[disabled]');assert.ok(await newButtons.count()>=4,'unwired editor creation must be disabled')
 await mkdir('test-results',{recursive:true});await page.screenshot({path:'test-results/local-shell-home.png',fullPage:true})
 await page.locator('.account-btn').click();await page.getByRole('button',{name:'个人设置',exact:true}).click()
 const dialog=page.getByRole('dialog');await expect(dialog).toContainText('本地账号会话');await expect(dialog).toContainText('alice')
 await page.screenshot({path:'test-results/local-shell-account.png',fullPage:true})
 await dialog.getByRole('button',{name:'通用',exact:true}).click();await expect(dialog.locator('#set-author-name')).toBeEnabled();await dialog.locator('#set-author-name').fill('Alice browser author')
 const saved=page.waitForResponse(r=>r.url().endsWith('/api/v1/preferences')&&r.request().method()==='PUT');await dialog.locator('#set-author-name').press('Enter');assert.equal((await saved).status(),200)
 assert.equal((await f.preferences.get(f.alice.token)).authorName,'Alice browser author');assert.equal((await f.preferences.get(f.bob.token)).authorName,'')
 await dialog.locator('.set-pane').evaluate(el=>{el.scrollTop=0});await page.screenshot({path:'test-results/local-shell-general.png',fullPage:true})
 await page.reload();await expect(page.locator('.home')).toBeVisible();await page.locator('.account-btn').click();await page.getByRole('button',{name:'退出登录',exact:true}).click();await expect(page.getByLabel('用户名',{exact:true})).toBeVisible()
 await login('bob');await expect(page.getByText('alice-private.docx',{exact:true})).toHaveCount(0)
 assert.deepEqual(await page.evaluate(()=>[...Object.keys(localStorage),...Object.keys(sessionStorage)].filter(key=>/token|password|session/i.test(key))),[]);assert.deepEqual(errors,[])
})
