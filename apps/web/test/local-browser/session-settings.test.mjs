import test from 'node:test'
import assert from 'node:assert/strict'
import {fileURLToPath} from 'node:url'
import {mkdir} from 'node:fs/promises'
import {expect} from '@playwright/test'
import {launchTestBrowser} from '../helpers/browser.mjs'
import {fileFixture} from '../helpers/files.mjs'
import {password} from '../helpers/identity.mjs'
import {buildLocalApp} from '../../server/src/app.ts'
test('original Settings lists only own sessions and confirms CSRF-protected per-session revocation',{timeout:120_000},async t=>{
 const origin='http://localhost:4201',f=await fileFixture(t,{origin})
 const app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,localShellDirectory:fileURLToPath(new URL('../../dist-local-shell',import.meta.url))})
 f.cleanup.push(()=>app.close());await app.listen({port:4201,host:'127.0.0.1'})
 const browser=await launchTestBrowser();t.after(()=>browser.close());const context=await browser.newContext({viewport:{width:1440,height:1100}});const page=await context.newPage()
 await page.goto(origin);await page.getByLabel('用户名',{exact:true}).fill('alice');await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.locator('.home')).toBeVisible()
 let token=(await context.cookies()).find(c=>c.name==='__Host-dyoffice-session').value
 await page.locator('.account-btn').click();await page.getByRole('button',{name:'个人设置',exact:true}).click();const sessions=page.getByRole('region',{name:'登录会话'})
 await expect(sessions.locator('[data-session-id]')).toHaveCount(2);await expect(sessions.locator(`[data-session-id="${f.bob.sessionId}"]`)).toHaveCount(0)
 const ownRow=sessions.locator(`[data-session-id="${f.alice.sessionId}"]`);await expect(ownRow).toBeVisible()
 const me=auth=>app.inject({url:'/api/v1/auth/me',headers:{cookie:'__Host-dyoffice-session='+auth}})
 assert.equal((await app.inject({method:'DELETE',url:'/api/v1/auth/sessions/'+f.alice.sessionId,headers:{origin,cookie:'__Host-dyoffice-session='+token}})).statusCode,403);assert.equal((await me(f.alice.token)).statusCode,200)
 await ownRow.getByRole('button',{name:'撤销此会话',exact:true}).click();await sessions.getByRole('button',{name:'取消',exact:true}).click();assert.equal((await me(f.alice.token)).statusCode,200)
 await ownRow.getByRole('button',{name:'撤销此会话',exact:true}).click();const revoked=page.waitForResponse(r=>r.url().endsWith('/auth/sessions/'+f.alice.sessionId)&&r.request().method()==='DELETE');await sessions.getByRole('button',{name:'确认撤销',exact:true}).click();assert.equal((await revoked).status(),204);await expect(ownRow).toHaveCount(0);assert.equal((await me(f.alice.token)).statusCode,401);assert.equal((await me(f.bob.token)).statusCode,200)
 const extra1=await f.sessions.login('alice',password),extra2=await f.sessions.login('alice',password)
 await sessions.getByRole('button',{name:'刷新会话列表',exact:true}).click();await expect(sessions.locator('[data-session-id]')).toHaveCount(3)
 assert.equal((await app.inject({method:'POST',url:'/api/v1/auth/sessions/revoke-others',headers:{origin,cookie:'__Host-dyoffice-session='+token}})).statusCode,403)
 await sessions.getByRole('button',{name:'撤销所有其他会话',exact:true}).click();await sessions.getByRole('button',{name:'取消',exact:true}).click();assert.equal((await me(extra1.token)).statusCode,200)
 await sessions.getByRole('button',{name:'撤销所有其他会话',exact:true}).click();const bulk=page.waitForResponse(r=>r.url().endsWith('/auth/sessions/revoke-others'));await sessions.getByRole('button',{name:'确认撤销',exact:true}).click();assert.equal((await bulk).status(),204)
 await expect(sessions.locator('[data-session-id]')).toHaveCount(1);assert.equal((await me(extra1.token)).statusCode,401);assert.equal((await me(extra2.token)).statusCode,401);assert.equal((await me(token)).statusCode,200);assert.equal((await me(f.bob.token)).statusCode,200)
 assert.equal((await context.cookies()).find(c=>c.name==='__Host-dyoffice-session').value,token)
 await sessions.scrollIntoViewIfNeeded();await mkdir('test-results',{recursive:true});await page.screenshot({path:'test-results/local-shell-sessions.png',fullPage:true})
 // Password rotation changes the current session ID: the account pane must reload the list.
 const dialog=page.getByRole('dialog'),next='session rotation river lanterns 7038'
 await dialog.getByLabel('当前密码',{exact:true}).fill(password);await dialog.getByLabel('新密码',{exact:true}).fill(next);await dialog.getByLabel('确认新密码',{exact:true}).fill(next)
 await dialog.getByRole('button',{name:'修改密码',exact:true}).click();await expect(dialog.getByRole('status')).toContainText('当前会话已更新')
 token=(await context.cookies()).find(c=>c.name==='__Host-dyoffice-session').value
 const active=(await app.inject({url:'/api/v1/auth/sessions',headers:{cookie:'__Host-dyoffice-session='+token}})).json().sessions.find(row=>row.current)
 await expect(sessions.locator(`[data-session-id="${active.id}"]`)).toBeVisible();await expect(sessions.locator('[data-session-id]')).toHaveCount(1)
 await sessions.getByRole('button',{name:'撤销当前会话',exact:true}).click();await sessions.getByRole('button',{name:'确认撤销',exact:true}).click();await expect(page.getByLabel('用户名',{exact:true})).toBeVisible();assert.equal((await me(token)).statusCode,401)
})
