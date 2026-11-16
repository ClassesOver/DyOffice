import test from 'node:test'
import assert from 'node:assert/strict'
import {fileURLToPath} from 'node:url'
import {mkdir} from 'node:fs/promises'
import {chromium,expect} from '@playwright/test'
import {fileFixture} from '../helpers/files.mjs'
import {password} from '../helpers/identity.mjs'
import {buildLocalApp} from '../../server/src/app.ts'
// Disposable real PG + actual Chromium. Never route/mock requests or log action codes.
test('administrator UI creates activates resets and manages roles with authoritative session revocation',{timeout:240_000},async t=>{
 const origin='http://localhost:4201',newPassword='silver valley lanterns orbit 3762'
 const f=await fileFixture(t,{origin})
 const app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,localShellDirectory:fileURLToPath(new URL('../../dist-local-shell',import.meta.url))})
 f.cleanup.push(()=>app.close());await app.listen({port:4201,host:'127.0.0.1'})
 const browser=await chromium.launch();t.after(()=>browser.close())
 const ownerContext=await browser.newContext({viewport:{width:1440,height:1100}}),owner=await ownerContext.newPage()
 const userContext=await browser.newContext({viewport:{width:1440,height:1100}}),user=await userContext.newPage()
 const errors=[];for(const p of [owner,user])p.on('pageerror',e=>errors.push(e.message))
 const login=async(p,name,secret=password)=>{await p.getByLabel('用户名',{exact:true}).fill(name);await p.getByLabel('密码',{exact:true}).fill(secret);await p.getByRole('button',{name:'登录',exact:true}).click();await expect(p.locator('.home')).toBeVisible()}
 const openAdmin=async p=>{await p.locator('.account-btn').click();await p.getByRole('button',{name:'用户管理',exact:true}).click();await expect(p.locator('section[aria-label="用户管理"]')).toBeVisible()}
 const panel=p=>p.locator('section[aria-label="用户管理"]')
 const row=(p,name)=>panel(p).locator('li').filter({has:p.locator('strong').filter({hasText:new RegExp('^'+name+'$')})})
 const confirm=async(p,path,expected=200,secret=password)=>{
  const form=panel(p).getByRole('form',{name:'确认用户操作'})
  await form.getByLabel('管理员当前密码',{exact:true}).fill(secret)
  const response=p.waitForResponse(r=>r.url().includes(path)&&['POST','PATCH'].includes(r.request().method()))
  await form.getByRole('button',{name:'验证并确认',exact:true}).click();assert.equal((await response).status(),expected)
 }
 const redeem=async(p,token,purpose,secret)=>{
  await p.goto(origin);await p.getByRole('button',{name:'激活或重置密码',exact:true}).click()
  const form=p.locator('section[aria-label="激活或重置密码"]')
  await form.getByLabel('用途',{exact:true}).selectOption(purpose)
  await form.getByLabel('一次性码',{exact:true}).fill(token);await form.getByLabel('新密码',{exact:true}).fill(secret);await form.getByLabel('再次输入密码',{exact:true}).fill(secret)
  const response=p.waitForResponse(r=>r.url().endsWith('/auth/password-action'))
  await form.getByRole('button',{name:'设置密码',exact:true}).click();assert.equal((await response).status(),204)
  await expect(form.getByRole('status')).toContainText('不会自动登录');assert.equal(new URL(p.url()).search,'');assert.equal(new URL(p.url()).hash,'')
  await form.getByRole('button',{name:'返回登录',exact:true}).click()
 }
 const readAction=async p=>{const field=panel(p).getByLabel('一次性码',{exact:true});await expect(field).toBeVisible();const code=await field.inputValue();assert.equal(code.length,43);await panel(p).getByRole('button',{name:'已记录，隐藏',exact:true}).click();await expect(field).toHaveCount(0);return code}
 const me=token=>app.inject({url:'/api/v1/auth/me',headers:{cookie:'__Host-dyoffice-session='+token}})
 await owner.goto(origin);await login(owner,'owner');await openAdmin(owner)
 // Last admin removal must be visibly rejected, not a successful local state change.
 await row(owner,'owner').getByRole('button',{name:'编辑角色',exact:true}).click()
 await panel(owner).getByLabel('配置管理员',{exact:true}).uncheck()
 await confirm(owner,'/api/v1/admin/users/',409)
 await expect(panel(owner).getByRole('alert')).toContainText('冲突')
 await panel(owner).getByRole('button',{name:'刷新列表',exact:true}).click()
 await expect(row(owner,'owner')).toContainText('config_admin')
 // Explicit creation and one-time activation through signed-out browser.
 await panel(owner).getByLabel('新用户名',{exact:true}).fill('carol')
 await panel(owner).getByLabel('显示名称',{exact:true}).fill('Carol')
 await panel(owner).getByRole('button',{name:'创建账号',exact:true}).click()
 await confirm(owner,'/api/v1/admin/users',201)
 const activate=await readAction(owner)
 await redeem(user,activate,'activate',password);await login(user,'carol')
 const carolCookie=(await userContext.cookies()).find(c=>c.name==='__Host-dyoffice-session').value
 await panel(owner).getByRole('button',{name:'刷新列表',exact:true}).click()
 await expect(row(owner,'Carol')).toContainText('active')
 // Grant replaces role set and revokes the target's previously live browser session.
 await row(owner,'Carol').getByRole('button',{name:'编辑角色',exact:true}).click()
 await panel(owner).getByLabel('配置管理员',{exact:true}).check()
 await confirm(owner,'/api/v1/admin/users/')
 assert.equal((await me(carolCookie)).statusCode,401)
 await user.reload();await login(user,'carol');await openAdmin(user)
 // With another available admin, self-demotion succeeds and forces a new login.
 await row(owner,'owner').getByRole('button',{name:'编辑角色',exact:true}).click()
 await panel(owner).getByLabel('配置管理员',{exact:true}).uncheck()
 await confirm(owner,'/api/v1/admin/users/')
 await expect(owner.getByLabel('用户名',{exact:true})).toBeVisible()
 await login(owner,'owner');await owner.locator('.account-btn').click();await expect(owner.getByRole('button',{name:'用户管理',exact:true})).toHaveCount(0)
 // Reset immediately invalidates the target's old session/password, then redeem/re-login.
 await row(user,'alice').getByRole('button',{name:'重置密码',exact:true}).click()
 await confirm(user,'/api/v1/admin/users/'+f.alice.user.id+'/password-reset')
 const reset=await readAction(user);assert.equal((await me(f.alice.token)).statusCode,401)
 assert.equal(await f.accounts.verifyCredentials('alice',password),null)
 const resetContext=await browser.newContext(),resetPage=await resetContext.newPage()
 await redeem(resetPage,reset,'reset',newPassword);await login(resetPage,'alice',newPassword)
 assert.ok(await f.accounts.verifyCredentials('alice',newPassword))
 // Disable/re-enable preserves credentials but revokes existing sessions.
 await row(user,'bob').getByRole('button',{name:'禁用账号',exact:true}).click()
 await confirm(user,'/api/v1/admin/users/'+f.bob.user.id)
 assert.equal((await me(f.bob.token)).statusCode,401)
 await expect(row(user,'bob')).toContainText('disabled')
 await row(user,'bob').getByRole('button',{name:'启用账号',exact:true}).click()
 await confirm(user,'/api/v1/admin/users/'+f.bob.user.id);await expect(row(user,'bob')).toContainText('active')
 // No secrets in URL/storage or screenshots: all issued codes have been hidden.
 for(const p of [owner,user,resetPage])assert.deepEqual(await p.evaluate(()=>[...Object.keys(localStorage),...Object.keys(sessionStorage)].filter(k=>/token|password|session/i.test(k))),[])
 await mkdir('test-results',{recursive:true});await user.screenshot({path:'test-results/local-shell-admin-complete.png',fullPage:true})
 assert.deepEqual(errors,[])
})
