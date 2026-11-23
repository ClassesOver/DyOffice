import test from 'node:test'
import assert from 'node:assert/strict'
import {randomBytes} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import {mkdir} from 'node:fs/promises'
import {expect} from '@playwright/test'
import {fileFixture} from '../helpers/files.mjs'
import {password} from '../helpers/identity.mjs'
import {launchTestBrowser} from '../helpers/browser.mjs'
import {buildLocalApp} from '../../server/src/app.ts'

test('browser manages PostgreSQL connections and table scope without manual query UI',{timeout:120000},async t=>{
 const origin='http://localhost:4286',f=await fileFixture(t,{origin})
 const reader='source_ui_'+randomBytes(6).toString('hex'),secret=randomBytes(16).toString('hex')
 const pageTables=Array.from({length:50},(_,i)=>'scope_page_'+String(i).padStart(2,'0'))
 await f.admin.query(`CREATE ROLE ${reader} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${secret}'`)
 f.cleanup.push(async()=>{await f.ownerPool.query('DROP TABLE IF EXISTS '+pageTables.join(','));await f.ownerPool.query('DROP TABLE IF EXISTS source_ui_allowed,source_ui_hidden');await f.ownerPool.query(`REVOKE CONNECT ON DATABASE "${f.database}" FROM ${reader}`);await f.ownerPool.query(`REVOKE USAGE ON SCHEMA public FROM ${reader}`);await f.admin.query(`DROP ROLE ${reader}`)})
 await f.admin.query(`ALTER ROLE ${reader} SET default_transaction_read_only=on`)
 await f.ownerPool.query(`GRANT CONNECT ON DATABASE "${f.database}" TO ${reader}`)
 await f.ownerPool.query(`GRANT USAGE ON SCHEMA public TO ${reader}`)
 await f.ownerPool.query('CREATE TABLE source_ui_allowed(amount integer); CREATE TABLE source_ui_hidden(amount integer)')
 await f.ownerPool.query('INSERT INTO source_ui_allowed VALUES(42),(43); INSERT INTO source_ui_hidden VALUES(999)')
 await f.ownerPool.query(`GRANT SELECT ON source_ui_allowed,source_ui_hidden TO ${reader}`)

 await f.ownerPool.query(pageTables.map(name=>'CREATE TABLE '+name+'(id integer)').join(';'))
 await f.ownerPool.query(`GRANT SELECT ON ${pageTables.join(',')} TO ${reader}`)
 const target=new URL(process.env.DYOFFICE_TEST_DATABASE_URL)
 target.pathname='/'+f.database;target.username=reader;target.password=secret
 const app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,
  sourcesCredentialKeys:'ui:'+randomBytes(32).toString('base64'),
  sourcesEgressTargets:[{kind:'postgres',endpoint:target.protocol+'//'+target.host,username:reader,database:f.database,addresses:['127.0.0.1'],allowInsecure:true}],
  localShellDirectory:fileURLToPath(new URL('../../dist-local-shell',import.meta.url))})
 f.cleanup.push(()=>app.close());await app.listen({host:'127.0.0.1',port:4286})
 const browser=await launchTestBrowser();t.after(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),requests=[],errors=[],toolCalls=[]
 page.on('request',r=>{requests.push(r.url());if(r.url().includes('/source-tools/execute')&&r.method()==='POST')toolCalls.push(r.postDataJSON().name)});page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(12000)
 await page.goto(origin);await page.getByLabel('用户名',{exact:true}).fill('owner');await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'登录',exact:true}).click()
 await page.locator('.account-btn').click();await page.getByRole('menuitem',{name:'数据连接',exact:true}).click()
 const panel=page.getByRole('dialog',{name:'数据连接',exact:true})
 const tab=name=>panel.getByRole('tab',{name,exact:true}).click()
 const tableScope=async()=>{
  await tab('可见范围')
  const manual=panel.locator('details.dc-manual-scope')
  if(await manual.getAttribute('open')===null)await manual.getByText('手工填写范围',{exact:true}).click()
  return panel.getByLabel('允许访问的表',{exact:true})
 }
 await page.getByRole('button',{name:'新建数据连接',exact:true}).click()
 await page.getByLabel('连接标识',{exact:true}).fill('browser-current')
 await page.getByLabel('连接名称',{exact:true}).fill('当前连接验收')
 await page.getByLabel('连接凭据',{exact:true}).fill(target.href)
 await tab('可见范围');await panel.getByRole('combobox',{name:'表可见范围',exact:true}).selectOption('selected')
 await (await tableScope()).fill('public.source_ui_allowed')
 await tab('连接设置')
 await page.getByRole('checkbox',{name:'启用数据连接',exact:true}).uncheck()
 await page.getByRole('button',{name:'保存连接',exact:true}).click()
 await expect(page.getByText('连接已保存，当前已停用。',{exact:true})).toBeVisible()
 await expect(page.getByRole('checkbox',{name:'启用数据连接',exact:true})).not.toBeChecked()
 await expect(page.getByRole('button',{name:'测试连接',exact:true})).toBeDisabled()
 await expect(page.getByRole('button',{name:'执行查询',exact:true})).toHaveCount(0)
 await page.getByRole('checkbox',{name:'启用数据连接',exact:true}).check()
 await page.getByRole('button',{name:'保存连接',exact:true}).click()
 await expect(page.getByText('连接已保存并生效，可测试连接。',{exact:true})).toBeVisible()
 await expect(panel).not.toContainText(/版本|发布/)
 await expect(page.getByLabel('连接凭据',{exact:true})).toHaveCount(0)
 await page.getByRole('button',{name:'测试连接',exact:true}).click()
 await expect(page.getByText('连接测试通过。',{exact:true})).toBeVisible()
 await expect(page.getByLabel('只读 SQL',{exact:true})).toHaveCount(0)
 await mkdir('test-results/configuration-experience',{recursive:true})
 const scopeInput=await tableScope()
 await panel.getByRole('button',{name:'读取目录和表',exact:true}).click()
 const tables=panel.locator('details[aria-label="目录 public 的表"]')
 await tables.getByRole('button',{name:'下一页'}).click()
 await expect(tables.getByLabel('允许表 public.source_ui_allowed',{exact:true})).toBeChecked()
 const bulk=tables.locator('.dc-bulk-options')
 const selectPage=bulk.getByRole('button',{name:'勾选已读取的表（2）',exact:true})
 await expect(selectPage).toBeHidden()
 await bulk.locator('summary').focus()
 await page.keyboard.press('Enter')
 await expect(selectPage).toBeVisible()
 await bulk.locator('summary').click()
 await expect(selectPage).toBeHidden()
 await tables.getByRole('button',{name:'上一页'}).click()
 await expect(tables.getByLabel('允许表 public.scope_page_00',{exact:true})).toBeVisible()
 for(const width of [1440,390]){
  await page.setViewportSize({width,height:1000})
  await scopeInput.scrollIntoViewIfNeeded()
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1))
  await page.screenshot({animations:'disabled',path:`test-results/configuration-experience/sources-scope-${width}.png`})
 }
 await page.setViewportSize({width:1440,height:1000})
 await page.getByRole('button',{name:'返回连接列表',exact:true}).click()
 for(const width of [1440,390]){
  await page.setViewportSize({width,height:1000})
  await expect(page.getByRole('button',{name:'编辑连接 当前连接验收',exact:true})).toBeVisible()
  await page.screenshot({animations:'disabled',path:`test-results/configuration-experience/connections-list-${width}.png`})
 }
 await page.getByRole('button',{name:'编辑连接 当前连接验收',exact:true}).click()
 await expect(await tableScope()).toHaveValue('public.source_ui_allowed')
 await tab('高级配置')
 await page.getByLabel('查询最大行数',{exact:true}).fill('1')
 await page.getByRole('button',{name:'保存连接',exact:true}).click()
 await expect(page.getByText('连接已保存并生效，可测试连接。',{exact:true})).toBeVisible()
 await page.getByRole('button',{name:'返回连接列表',exact:true}).click()
 await page.getByRole('button',{name:'编辑连接 当前连接验收',exact:true}).click()
 await tab('高级配置')
 await expect(page.getByLabel('查询最大行数',{exact:true})).toHaveValue('1')
 await expect(panel.locator('[class^="ant-"]')).toHaveCount(0)
 await page.getByRole('button',{name:'关闭数据连接',exact:true}).click()
 await page.locator('.account-btn').click()
 await expect(page.getByRole('menuitem',{name:'数据查询',exact:true})).toHaveCount(0)
 assert.equal(toolCalls.filter(name=>name==='sources.query').length,0)
 assert.equal(requests.some(url=>url.endsWith('/publish')),false)
 assert.deepEqual(errors,[])
})
