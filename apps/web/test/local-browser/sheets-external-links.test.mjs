import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {expect} from '@playwright/test'
import JSZip from 'jszip'
import {buildLocalApp} from '../../server/src/app.ts'
import {buildSheetsGateway} from '../../server/sheets/build.mjs'
import {configuredSheetsRuntime} from '../../server/src/modules/sheets/runtime.ts'
import {launchTestBrowser} from '../helpers/browser.mjs'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {password} from '../helpers/identity.mjs'
import {stubHomeHero} from '../helpers/home-hero.mjs'

const sheetsDirectory=process.env.DYOFFICE_TEST_SHEETS_DIST

test('XLSX save and reopen preserve an untouched external formula and its source cache without fetching the link',{skip:!sheetsDirectory,timeout:120000},async t=>{
 let app,externalRequests=0
 const server=createServer((request,response)=>{
  if(request.url==='/linked-source.xlsx'){
   externalRequests++
   response.writeHead(404).end()
   return
  }
  app.routing(request,response)
 })
 t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve))})
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 const origin='http://127.0.0.1:'+server.address().port
 const f=await fileFixture(t,{origin,buildApp:false})
 await f.preferences.update(f.alice.token,{language:'en',autoSave:false})

 const directory=await mkdtemp(join(tmpdir(),'dyoffice-external-xlsx-'))
 f.cleanup.push(()=>rm(directory,{recursive:true,force:true}))
 await buildSheetsGateway(join(directory,'gateway.mjs'))
 const runtime=await configuredSheetsRuntime({
  DYOFFICE_AUTH_MODE:'local',DYOFFICE_SANDBOX_MODE:'subprocess',DYOFFICE_DEPLOYMENT_ID:f.deploymentId,
  DYOFFICE_XLSX_NODE_ENGINE:join(directory,'xlsx-node-engine.mjs'),
  DYOFFICE_XLSX_GATEWAY_RUNNER:join(directory,'gateway-process.mjs'),
  DYOFFICE_NATIVE_XLSX_DIRECTORY:sheetsDirectory,
 },{enabled:true})
 f.cleanup.unshift(()=>runtime.close())
 const zip=await JSZip.loadAsync(await readFile(new URL('../fixtures/sheets/acceptance.xlsx',import.meta.url)))
 const worksheet='xl/worksheets/sheet1.xml'
 const book='xl/workbook.xml'
 const bookRelationships='xl/_rels/workbook.xml.rels'
 const link='xl/externalLinks/externalLink1.xml'
 const linkRelationships='xl/externalLinks/_rels/externalLink1.xml.rels'
 const sheetNamespace='http://schemas.openxmlformats.org/spreadsheetml/2006/main'
 const relationshipNamespace='http://schemas.openxmlformats.org/officeDocument/2006/relationships'
 const packageRelationshipNamespace='http://schemas.openxmlformats.org/package/2006/relationships'
 const reference='<externalReference r:id="rIdExternal1"/>'
 const relationship=`<Relationship Id="rIdExternal1" Type="${relationshipNamespace}/externalLink" Target="externalLinks/externalLink1.xml"/>`
 const formula='<c r="G3"><f>[1]Catalog!$A$1</f><v>84</v></c>'
 const update=async(path,find,replacement)=>{
  const xml=await zip.file(path).async('string')
  assert.ok(xml.includes(find),path)
  zip.file(path,xml.replace(find,replacement))
 }
 await update(book,'</sheets>',`</sheets><externalReferences>${reference}</externalReferences>`)
 await update(bookRelationships,'</Relationships>',relationship+'</Relationships>')
 await update('[Content_Types].xml','</Types>',`<Override PartName="/${link}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.externalLink+xml"/></Types>`)
 await update(worksheet,'A1:F3','A1:G3')
 await update(worksheet,'<row r="3"><c r="A3"><v>7.5</v></c></row>',`<row r="3"><c r="A3"><v>7.5</v></c>${formula}</row>`)
 zip.file(link,`<externalLink xmlns="${sheetNamespace}" xmlns:r="${relationshipNamespace}"><externalBook r:id="rId1"><sheetNames><sheetName val="Catalog"/></sheetNames><sheetDataSet><sheetData sheetId="0"><row r="1"><cell r="A1"><v>84</v></cell></row></sheetData></sheetDataSet></externalBook></externalLink>`)
 zip.file(linkRelationships,`<Relationships xmlns="${packageRelationshipNamespace}"><Relationship Id="rId1" Type="${relationshipNamespace}/externalLinkPath" Target="${origin}/linked-source.xlsx" TargetMode="External"/></Relationships>`)
 const original=await zip.generateAsync({type:'nodebuffer'})
 const initial=(await importFile(f,f.alice.token,original,'external-reference.xlsx')).file
 app=await buildLocalApp({
  db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,
  csrfKey:f.csrfKey,objectStore:f.objects,codingHarnesses:false,
  localShellDirectory:process.env.DYOFFICE_TEST_LOCAL_SHELL_DIRECTORY,...runtime,
 })
 f.cleanup.unshift(()=>app.close())
 await app.ready()
 const browser=await launchTestBrowser()
 f.cleanup.unshift(()=>browser.close())
 const page=await browser.newPage()
 await page.addInitScript(()=>{window.__genofficeDebugHooks=true})
 await stubHomeHero(page)
 await page.goto(origin)
 await page.getByLabel('用户名',{exact:true}).fill('alice')
 await page.getByLabel('密码',{exact:true}).fill(password)
 await page.getByRole('button',{name:'登录',exact:true}).click()
 await expect(page.locator('.home')).toBeVisible()
 await page.goto(origin+'/native-xlsx/?fileId='+initial.fileId)
 const localAmount=()=>page.evaluate(()=>window.__genofficeDebug?.univerAPI.getActiveWorkbook()?.getActiveSheet()?.getRange('A2').getValue())
 await expect.poll(localAmount,{timeout:30000}).toBe(12.5)
 await page.evaluate(()=>window.__genofficeDebug.univerAPI.getActiveWorkbook().getActiveSheet().getRange('A2').setValue(21.25))
 const save=page.getByRole('button',{name:'Save and download',exact:true})
 const [download]=await Promise.all([page.waitForEvent('download',{timeout:30000}),save.click()])
 const bytes=await readFile(await download.path()),saved=await JSZip.loadAsync(bytes)
 assert.ok((await saved.file(book).async('string')).includes(reference))
 assert.ok((await saved.file(bookRelationships).async('string')).includes(relationship))
 assert.ok((await saved.file(worksheet).async('string')).includes(formula))
 for(const part of [link,linkRelationships]){
  assert.deepEqual(await saved.file(part).async('nodebuffer'),await zip.file(part).async('nodebuffer'))
 }
 const head=(await f.files.openFile(f.alice.token,initial.fileId)).file
 assert.notEqual(head.revision,initial.revision)
 assert.deepEqual(bytes,await f.files.readFile(f.alice.token,head.fileId,head.revision))
 assert.deepEqual(original,await f.files.readFile(f.alice.token,initial.fileId,initial.revision))
 await page.reload()
 await expect.poll(localAmount,{timeout:30000}).toBe(21.25)
 assert.equal(externalRequests,0)
})
