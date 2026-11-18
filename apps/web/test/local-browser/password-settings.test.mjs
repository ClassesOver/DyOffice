import test from 'node:test'
import assert from 'node:assert/strict'
import {fileURLToPath} from 'node:url'
import {mkdir} from 'node:fs/promises'
import {expect} from '@playwright/test'
import {launchTestBrowser} from '../helpers/browser.mjs'
import {accountAction, settingsTab, closeWorkspaceDialog} from '../helpers/workspace-ui.mjs'
import {fileFixture} from '../helpers/files.mjs'
import {password} from '../helpers/identity.mjs'
import {buildLocalApp} from '../../server/src/app.ts'
test('original Settings changes password with real session rotation and revokes old credentials',{timeout:120_000},async t=>{
 const origin='http://localhost:4200',next='amber forest river lanterns 9362'
 const f=await fileFixture(t,{origin})
 const app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,localShellDirectory:fileURLToPath(new URL('../../dist-local-shell',import.meta.url))})
 f.cleanup.push(()=>app.close());await app.listen({port:4200,host:'127.0.0.1'})
 const browser=await launchTestBrowser();t.after(()=>browser.close());const context=await browser.newContext({viewport:{width:1440,height:1100}});const page=await context.newPage()
 const login=async value=>{await page.getByLabel('用户名',{exact:true}).fill('alice');await page.getByLabel('密码',{exact:true}).fill(value);await page.getByRole('button',{name:'登录',exact:true}).click()}
 await page.goto(origin);await login(password);await expect(page.locator('.home')).toBeVisible()
 const oldCookie=(await context.cookies()).find(c=>c.name==='__Host-dyoffice-session').value
 await accountAction(page,'个人设置');const dialog=page.getByRole('dialog')
 // Real layout assertion: labels of different lengths share the original flexible label column.
 // Keep the original entrance motion. Sequential boundingBox reads sample different
 // scale(.99)->scale(1) frames; await finite animations and read all rectangles atomically.
 for(const label of ['当前密码','新密码','确认新密码'])await expect(dialog.getByLabel(label,{exact:true})).toBeVisible()
 await dialog.evaluate(async element=>{await document.fonts.ready;await Promise.all(element.getAnimations({subtree:true}).filter(animation=>Number.isFinite(animation.effect?.getComputedTiming().endTime)).map(animation=>animation.finished.catch(()=>{})))})
 const boxes=await dialog.locator('#local-current-password, #local-new-password, #local-confirm-password').evaluateAll(inputs=>inputs.map(input=>{const {x,width}=input.getBoundingClientRect();return {x,width}}))
 assert.equal(boxes.length,3)
 for(const box of boxes){assert.ok(Math.abs(box.x-boxes[0].x)<1,'password inputs start at the same x: '+JSON.stringify(boxes));assert.ok(Math.abs(box.width-boxes[0].width)<1,'password inputs have equal widths: '+JSON.stringify(boxes))}
 const fill=async current=>{await dialog.getByLabel('当前密码',{exact:true}).fill(current);await dialog.getByLabel('新密码',{exact:true}).fill(next);await dialog.getByLabel('确认新密码',{exact:true}).fill(next)}
 await fill('wrong current password');const rejected=page.waitForResponse(r=>r.url().endsWith('/auth/change-password'));await dialog.getByRole('button',{name:'修改密码',exact:true}).click();assert.equal((await rejected).status(),401);await expect(dialog.getByRole('alert')).toContainText('当前密码')
 assert.ok(await f.accounts.verifyCredentials('alice',password))
 await fill(password);const changed=page.waitForResponse(r=>r.url().endsWith('/auth/change-password'));await dialog.getByRole('button',{name:'修改密码',exact:true}).click();assert.equal((await changed).status(),200);await expect(dialog.getByRole('status').filter({hasText:'当前会话已更新'})).toBeVisible()
 for(const label of ['当前密码','新密码','确认新密码'])await expect(dialog.getByLabel(label,{exact:true})).toHaveValue('')
 const replacement=(await context.cookies()).find(c=>c.name==='__Host-dyoffice-session').value;assert.notEqual(replacement,oldCookie)
 const me=token=>app.inject({url:'/api/v1/auth/me',headers:{cookie:'__Host-dyoffice-session='+token}})
 assert.equal((await me(oldCookie)).statusCode,401);assert.equal((await me(f.alice.token)).statusCode,401);assert.equal((await me(replacement)).statusCode,200)
 assert.equal(await f.accounts.verifyCredentials('alice',password),null);assert.ok(await f.accounts.verifyCredentials('alice',next))
 await mkdir('test-results',{recursive:true});await page.screenshot({path:'test-results/local-shell-password-changed.png',fullPage:true})
 // The retained original settings UI can still write with the replacement CSRF.
 await settingsTab(dialog, '通用偏好');await expect(dialog.getByLabel('文档作者', {exact:true})).toBeEnabled();await dialog.getByLabel('文档作者', {exact:true}).fill('After password rotation')
 const saved=page.waitForResponse(r=>r.url().endsWith('/api/v1/preferences')&&r.request().method()==='PUT');await dialog.getByRole('button',{name:'保存个人偏好',exact:true}).click();assert.equal((await saved).status(),200)
 await closeWorkspaceDialog(dialog);await accountAction(page,'退出登录');await expect(page.getByLabel('用户名',{exact:true})).toBeVisible()
 await login(next);await expect(page.locator('.home')).toBeVisible()
 assert.deepEqual(await page.evaluate(()=>[...Object.keys(localStorage),...Object.keys(sessionStorage)].filter(k=>/password|token|session/i.test(k))),[])
})
