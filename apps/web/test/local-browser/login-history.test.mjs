import test from 'node:test'
import assert from 'node:assert/strict'
import {fileURLToPath} from 'node:url'
import {randomUUID} from 'node:crypto'
import {mkdir} from 'node:fs/promises'
import {expect} from '@playwright/test'
import {launchTestBrowser} from '../helpers/browser.mjs'
import {accountAction} from '../helpers/workspace-ui.mjs'
import {fileFixture} from '../helpers/files.mjs'
import {password} from '../helpers/identity.mjs'
import {buildLocalApp} from '../../server/src/app.ts'
test('original account login history displays only its private bounded projection',{timeout:120_000},async t=>{
 const origin='http://localhost:4203',f=await fileFixture(t,{origin})
 const aliceTime=new Date(Date.now()-120123).toISOString(),bobTime=new Date(Date.now()-180456).toISOString()
 for(const [user,time] of [[f.alice.user,aliceTime],[f.bob.user,bobTime]])await f.ownerPool.query('INSERT INTO auth_security_events(id,deployment_id,actor_id,event,request_id,created_at) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),f.deploymentId,user.id,'login_succeeded',randomUUID(),time])
 const app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,localShellDirectory:fileURLToPath(new URL('../../dist-local-shell',import.meta.url))})
 f.cleanup.push(()=>app.close());await app.listen({port:4203,host:'127.0.0.1'})
 assert.equal((await app.inject('/api/v1/auth/login-history')).statusCode,401)
 const browser=await launchTestBrowser();t.after(()=>browser.close());const context=await browser.newContext({viewport:{width:1440,height:1100}});const page=await context.newPage()
 await page.goto(origin)
 const sign=async(username,value)=>{await page.getByLabel('用户名',{exact:true}).fill(username);await page.getByLabel('密码',{exact:true}).fill(value);const response=page.waitForResponse(r=>r.url().endsWith('/auth/login')&&r.request().method()==='POST');await page.getByRole('button',{name:'登录',exact:true}).click();return response}
 assert.equal((await sign('alice','wrong password phrase')).status(),401)
 assert.equal((await sign('bob','another wrong password phrase')).status(),401)
 assert.equal((await sign('alice',password)).status(),200);await expect(page.locator('.home')).toBeVisible()
 const token=(await context.cookies()).find(c=>c.name==='__Host-dyoffice-session').value
 const response=await app.inject({url:'/api/v1/auth/login-history',headers:{cookie:'__Host-dyoffice-session='+token}});assert.equal(response.statusCode,200)
 const events=response.json().events;assert.ok(events.length<=20);assert.ok(events.some(e=>e.outcome==='failure'));assert.ok(events.some(e=>e.occurredAt===aliceTime));assert.ok(events.every(e=>e.occurredAt!==bobTime));for(const event of events)assert.deepEqual(Object.keys(event).sort(),['occurredAt','outcome'])
 const bob=(await app.inject({url:'/api/v1/auth/login-history',headers:{cookie:'__Host-dyoffice-session='+f.bob.token}})).json().events;assert.ok(bob.some(e=>e.occurredAt===bobTime));assert.ok(bob.every(e=>e.occurredAt!==aliceTime))
 assert.equal((await app.inject({url:'/api/v1/auth/login-history?owner='+f.bob.user.id,headers:{cookie:'__Host-dyoffice-session='+token}})).statusCode,400)
 await accountAction(page,'个人设置');const panel=page.getByRole('region',{name:'登录历史摘要'})
 await expect(panel.locator('[data-history-event]')).toHaveCount(events.length);await expect(panel.locator(`time[datetime="${aliceTime}"]`)).toBeVisible();await expect(panel.locator(`time[datetime="${bobTime}"]`)).toHaveCount(0);await expect(panel).toContainText('早期失败记录可能不包含')
 const text=await panel.textContent();for(const secret of [password,token,f.alice.user.id,f.bob.user.id])assert.equal(text.includes(secret),false)
 await panel.scrollIntoViewIfNeeded();await mkdir('test-results',{recursive:true});await page.screenshot({path:'test-results/local-shell-login-history.png',fullPage:true})
})
