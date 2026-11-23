import {expectManagementLayout} from '../helpers/management-layout.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import {fileURLToPath} from 'node:url'
import {mkdir} from 'node:fs/promises'
import {expect} from '@playwright/test'
import {launchTestBrowser} from '../helpers/browser.mjs'
import {accountAction} from '../helpers/workspace-ui.mjs'
import {fileFixture} from '../helpers/files.mjs'
import {password} from '../helpers/identity.mjs'
import {captureRecoveryState,expectRecoveryThenReload} from '../helpers/account-recovery.mjs'
import {buildLocalApp} from '../../server/src/app.ts'
// Disposable real PG + actual Chromium. Never route/mock requests or log action codes.
test('administrator UI creates activates resets and manages roles with authoritative session revocation',{timeout:240_000},async t=>{
 const origin='http://localhost:4201',newPassword='silver valley lanterns orbit 3762'
 const f=await fileFixture(t,{origin})
 const app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,localShellDirectory:fileURLToPath(new URL('../../dist-local-shell',import.meta.url))})
 f.cleanup.push(()=>app.close());await app.listen({port:4201,host:'127.0.0.1'})
 const browser=await launchTestBrowser();t.after(()=>browser.close())
 const ownerContext=await browser.newContext({viewport:{width:1440,height:1100}}),owner=await ownerContext.newPage()
 const userContext=await browser.newContext({viewport:{width:1440,height:1100}}),user=await userContext.newPage()
 const errors=[];for(const p of [owner,user])p.on('pageerror',e=>errors.push(e.message))
 const login=async(p,name,secret=password)=>{await p.getByLabel('用户名',{exact:true}).fill(name);await p.getByLabel('密码',{exact:true}).fill(secret);await p.getByRole('button',{name:'登录',exact:true}).click();await expect(p.locator('.home')).toBeVisible()}
 const openAdmin=async p=>{await accountAction(p,'用户管理');await expect(p.locator('section[aria-label="用户管理"]')).toBeVisible()}
 const panel=p=>p.locator('section[aria-label="用户管理"]')
 const row=(p,name)=>panel(p).locator('tr[data-row-key]').filter({has:p.locator('strong').filter({hasText:new RegExp('^'+name+'$')})})
 const confirm=async(p,path,expected=200,secret=password)=>{
  const form=panel(p).getByRole('form',{name:'确认用户操作'})
  await form.getByLabel('管理员当前密码',{exact:true}).fill(secret)
  const response=p.waitForResponse(r=>r.url().includes(path)&&['POST','PATCH'].includes(r.request().method()))
  await form.getByRole('button',{name:'验证并确认',exact:true}).click();const result=await response;assert.equal(result.status(),expected);return result
 }
 const redeem=async(p,token,secret)=>{
  await p.goto(origin);await p.getByRole('button',{name:'设置密码',exact:true}).click()
  const form=p.getByRole('region',{name:'设置密码',exact:true})
  await expect(form.getByRole('combobox')).toHaveCount(0)
  await form.getByLabel('一次性码',{exact:true}).fill(token);await form.getByLabel('新密码',{exact:true}).fill(secret);await form.getByLabel('再次输入密码',{exact:true}).fill(secret)
  const response=p.waitForResponse(r=>r.url().endsWith('/auth/password-action'))
  await form.getByRole('button',{name:'设置密码',exact:true}).click();assert.equal((await response).status(),204)
  await expect(form.getByRole('status')).toContainText('不会自动登录');assert.equal(new URL(p.url()).search,'');assert.equal(new URL(p.url()).hash,'')
  await form.getByRole('button',{name:'返回登录',exact:true}).click()
 }
 const readAction=async p=>{const field=panel(p).getByLabel('一次性码',{exact:true});await expect(field).toBeVisible();const code=await field.inputValue();assert.equal(code.length,43);await panel(p).getByRole('button',{name:'已记录，隐藏',exact:true}).click();await expect(field).toHaveCount(0);return code}
 const me=token=>app.inject({url:'/api/v1/auth/me',headers:{cookie:'__Host-dyoffice-session='+token}})
 await owner.goto(origin);await login(owner,'owner');await owner.locator('.home input[type="search"]').fill('retained administrator search');await openAdmin(owner)
 await expectManagementLayout(owner,panel(owner),'成员与权限','成员')
 // Last admin removal must be visibly rejected, not a successful local state change.
 await row(owner,'owner').getByRole('button',{name:'编辑角色',exact:true}).click()
 await panel(owner).getByLabel('配置管理员',{exact:true}).uncheck()
 await confirm(owner,'/api/v1/admin/users/',409)
 await expect(panel(owner).getByRole('alert')).toContainText('冲突')
 await panel(owner).getByRole('button',{name:'刷新列表',exact:true}).click()
 await expect(row(owner,'owner')).toContainText('配置管理员')
 // Explicit creation and one-time activation through signed-out browser.
 await panel(owner).getByRole('button',{name:'新建用户',exact:true}).click()
 await panel(owner).getByLabel('新用户名',{exact:true}).fill('carol')
 await panel(owner).getByLabel('显示名称',{exact:true}).fill('Carol')
 await panel(owner).getByRole('button',{name:'创建账号',exact:true}).click()
 await confirm(owner,'/api/v1/admin/users',201)
 const activate=await readAction(owner)
 await redeem(user,activate,password);await login(user,'carol')
 const carolCookie=(await userContext.cookies()).find(c=>c.name==='__Host-dyoffice-session').value
 await panel(owner).getByRole('button',{name:'刷新列表',exact:true}).click()
 await expect(row(owner,'Carol')).toContainText('已启用')
 // Grant replaces role set and revokes the target's previously live browser session.
 await row(owner,'Carol').getByRole('button',{name:'编辑角色',exact:true}).click()
 await panel(owner).getByLabel('配置管理员',{exact:true}).check()
 await confirm(owner,'/api/v1/admin/users/')
 assert.equal((await me(carolCookie)).statusCode,401)
 await user.reload();await login(user,'carol');await openAdmin(user)
 // Reset immediately invalidates the target's old session/password, then redeem/re-login.
 await row(user,'alice').getByRole('button',{name:'重置密码',exact:true}).click()
 await confirm(user,'/api/v1/admin/users/'+f.alice.user.id+'/password-reset')
 const reset=await readAction(user);assert.equal((await me(f.alice.token)).statusCode,401)
 assert.equal(await f.accounts.verifyCredentials('alice',password),null)
 const resetContext=await browser.newContext(),resetPage=await resetContext.newPage()
 await redeem(resetPage,reset,newPassword);await login(resetPage,'alice',newPassword)
 assert.ok(await f.accounts.verifyCredentials('alice',newPassword))
 // Self-demotion invalidates authority immediately, but preserves the renderer until explicit reload.
 const ownerState=await captureRecoveryState(owner)
 await row(owner,'owner').getByRole('button',{name:'编辑角色',exact:true}).click()
 await panel(owner).getByLabel('配置管理员',{exact:true}).uncheck()
 const ownRoleResponse=await confirm(owner,'/api/v1/admin/users/')
 const cookie=(await ownRoleResponse.request().allHeaders()).cookie??''
 const revokedOwnerToken=cookie.split(';').map(value=>value.trim()).find(value=>value.startsWith('__Host-dyoffice-session='))?.slice('__Host-dyoffice-session='.length)
 assert.ok(revokedOwnerToken);assert.equal((await me(revokedOwnerToken)).statusCode,401)
 await expectRecoveryThenReload(owner,ownerState)
 await login(owner,'owner');await owner.locator('.account-btn').click();await expect(owner.getByRole('menuitem',{name:'用户管理',exact:true})).toHaveCount(0)
 // Disable/re-enable preserves credentials but revokes existing sessions.
 await row(user,'bob').getByRole('button',{name:'禁用账号',exact:true}).click()
 await confirm(user,'/api/v1/admin/users/'+f.bob.user.id)
 assert.equal((await me(f.bob.token)).statusCode,401)
 await expect(row(user,'bob')).toContainText('已禁用')
 await row(user,'bob').getByRole('button',{name:'启用账号',exact:true}).click()
 await confirm(user,'/api/v1/admin/users/'+f.bob.user.id);await expect(row(user,'bob')).toContainText('已启用')
 // No secrets in URL/storage or screenshots: all issued codes have been hidden.
 for(const p of [owner,user,resetPage])assert.deepEqual(await p.evaluate(()=>[...Object.keys(localStorage),...Object.keys(sessionStorage)].filter(k=>/token|password|session/i.test(k))),[])
 await mkdir('test-results',{recursive:true});await user.screenshot({path:'test-results/local-shell-admin-complete.png',fullPage:true})
 assert.deepEqual(errors,[])
})
