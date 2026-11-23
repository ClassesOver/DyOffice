import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {expect} from '@playwright/test'
import JSZip from 'jszip'
import {buildLocalApp} from '../../server/src/app.ts'
import {buildSheetsGateway} from '../../server/sheets/build.mjs'
import {configuredSheetsRuntime} from '../../server/src/modules/sheets/runtime.ts'
import {launchTestBrowser} from '../helpers/browser.mjs'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {password} from '../helpers/identity.mjs'
import {stubHomeHero} from '../helpers/home-hero.mjs'

test('XLSX exports only the current sheet as a UTF-8 CSV without saving the workbook',{timeout:120000},async t=>{
 const port=4293,origin='http://127.0.0.1:'+port
 const f=await fileFixture(t,{origin,buildApp:false})
 await f.preferences.update(f.alice.token,{language:'zh',autoSave:false})
 const directory=await mkdtemp(join(tmpdir(),'dyoffice-sheets-csv-'))
 f.cleanup.push(()=>rm(directory,{recursive:true,force:true}))
 await buildSheetsGateway(join(directory,'gateway.mjs'))
 const runtime=await configuredSheetsRuntime({
  DYOFFICE_AUTH_MODE:'local',DYOFFICE_SANDBOX_MODE:'subprocess',DYOFFICE_DEPLOYMENT_ID:f.deploymentId,
  DYOFFICE_XLSX_NODE_ENGINE:join(directory,'xlsx-node-engine.mjs'),DYOFFICE_XLSX_GATEWAY_RUNNER:join(directory,'gateway-process.mjs'),
  DYOFFICE_NATIVE_XLSX_DIRECTORY:process.env.DYOFFICE_TEST_SHEETS_DIST,
 },{enabled:true})
 f.cleanup.unshift(()=>runtime.close())
 const zip=await JSZip.loadAsync(await readFile(new URL('../fixtures/sheets/acceptance.xlsx',import.meta.url)))
 const append=async(path,tag,value)=>zip.file(path,(await zip.file(path).async('string')).replace(tag,value+tag))
 await append('xl/workbook.xml','</sheets>','<sheet name="本月数据" sheetId="2" r:id="rIdCSV"/>')
 await append('xl/_rels/workbook.xml.rels','</Relationships>','<Relationship Id="rIdCSV" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>')
 await append('[Content_Types].xml','</Types>','<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>')
 zip.file('xl/worksheets/sheet2.xml','<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:B2"/><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>项目,名称</t></is></c><c r="B1" t="inlineStr"><is><t>数量</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>收入"甲"</t></is></c><c r="B2"><f>20+22</f><v>42</v></c></row></sheetData></worksheet>')
 const original=await zip.generateAsync({type:'nodebuffer'})
 const initial=(await importFile(f,f.alice.token,original,'销售.xlsx')).file
 const app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,codingHarnesses:false,localShellDirectory:fileURLToPath(new URL('../../dist-local-shell',import.meta.url)),...runtime})
 f.cleanup.unshift(()=>app.close())
 await app.listen({port,host:'127.0.0.1'})
 const browser=await launchTestBrowser()
 f.cleanup.unshift(()=>browser.close())
 const page=await browser.newPage(),errors=[]
 page.on('pageerror',error=>errors.push(error.message))
 await stubHomeHero(page)
 await page.goto(origin)
 await page.getByLabel('用户名',{exact:true}).fill('alice')
 await page.getByLabel('密码',{exact:true}).fill(password)
 await page.getByRole('button',{name:'登录',exact:true}).click()
 await expect(page.locator('.home')).toBeVisible()
 await page.goto(origin+'/native-xlsx/?fileId='+initial.fileId)
 await expect(page.locator('#univer-container canvas').first()).toBeVisible({timeout:30000})
 const activeSheet=page.getByRole('tab',{name:'本月数据',exact:true})
 await activeSheet.click()
 await expect(activeSheet).toHaveAttribute('aria-selected','true')
 await page.getByRole('button',{name:'文件',exact:true}).click()
 const button=page.getByRole('group',{name:'文件',exact:true}).getByRole('button',{name:'导出当前工作表为 CSV',exact:true})
 await expect(button).toBeEnabled()
 await button.click()
 const warning=page.getByRole('dialog').filter({hasText:'CSV 不保留格式'})
 await expect(warning).toContainText('仅导出当前工作表（本月数据）')
 await expect(warning).toContainText('公式将导出为计算后的数值')
 const [saved]=await Promise.all([page.waitForEvent('download',{timeout:20000}),warning.getByRole('button',{name:'继续保存为 CSV',exact:true}).click()])
 assert.equal(saved.suggestedFilename(),'销售.csv')
 const bytes=await readFile(await saved.path())
 assert.deepEqual(bytes,Buffer.from('\uFEFF"项目,名称",数量\r\n"收入""甲""",42\r\n'))
 assert.equal((await f.files.openFile(f.alice.token,initial.fileId)).file.revision,initial.revision)
 assert.deepEqual(errors,[])
})
