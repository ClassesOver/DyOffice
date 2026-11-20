import test from 'node:test'
import assert from 'node:assert/strict'
import {fileURLToPath} from 'node:url'
import {mkdir} from 'node:fs/promises'
import {expect} from '@playwright/test'
import {launchTestBrowser} from '../helpers/browser.mjs'
import {accountAction, settingsTab} from '../helpers/workspace-ui.mjs'
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
 const browser=await launchTestBrowser();t.after(()=>browser.close());const page=await browser.newPage({viewport:{width:1440,height:1000}})
 const errors=[];page.on('pageerror',error=>errors.push(error.message))
 const login=async name=>{await page.getByLabel('用户名',{exact:true}).fill(name);await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.locator('.home')).toBeVisible()}
 await page.goto(origin);await login('alice');await page.locator('.tree-name').filter({hasText:/^个人文件$/}).click();await expect(page.getByText('alice-private.docx',{exact:true})).toBeVisible()
 const newButtons=page.locator('.quick-card[disabled]');assert.ok(await newButtons.count()>=4,'unwired editor creation must be disabled')
 await mkdir('test-results',{recursive:true});await page.screenshot({path:'test-results/local-shell-home.png',fullPage:true})
 await accountAction(page,'个人设置')
 const dialog=page.getByRole('dialog',{name:'个人设置',exact:true});await expect(dialog.getByRole('tab',{name:'资料与安全',exact:true})).toHaveAttribute('aria-selected','true');await expect(dialog).toContainText('alice')
 await page.screenshot({path:'test-results/local-shell-account.png',fullPage:true})
 await settingsTab(dialog, '通用偏好');await expect(dialog.getByLabel('文档作者', {exact:true})).toBeEnabled();await dialog.getByLabel('文档作者', {exact:true}).fill('Alice browser author')
 const saved=page.waitForResponse(r=>r.url().endsWith('/api/v1/preferences')&&r.request().method()==='PUT');await dialog.getByRole('button',{name:'保存个人偏好',exact:true}).click();assert.equal((await saved).status(),200)
 assert.equal((await f.preferences.get(f.alice.token)).authorName,'Alice browser author');assert.equal((await f.preferences.get(f.bob.token)).authorName,'')
 await dialog.getByRole('tab',{name:'通用偏好',exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:'test-results/local-shell-general.png',fullPage:true})
 await page.reload();await expect(page.locator('.home')).toBeVisible()
 const session=(await page.context().cookies(origin)).find(cookie=>cookie.name==='__Host-dyoffice-session')
 assert.ok(session,'logout must start with a browser session')
 const [logout]=await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/v1/auth/logout')&&r.request().method()==='POST',{timeout:10000}),accountAction(page,'退出登录')])
 assert.equal(logout.status(),204);await expect(page.getByLabel('用户名',{exact:true})).toBeVisible()
 assert.equal((await app.inject({url:'/api/v1/auth/me',headers:{cookie:`${session.name}=${session.value}`}})).statusCode,401)
 await login('bob');await expect(page.getByText('alice-private.docx',{exact:true})).toHaveCount(0)
 assert.deepEqual(await page.evaluate(()=>[...Object.keys(localStorage),...Object.keys(sessionStorage)].filter(key=>/token|password|session/i.test(key))),[]);assert.deepEqual(errors,[])
})
