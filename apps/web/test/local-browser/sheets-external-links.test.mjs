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
import {createCsrfService,SESSION_COOKIE} from '../../server/src/modules/auth/csrf.ts'

const sheetsDirectory=process.env.DYOFFICE_TEST_SHEETS_DIST
const hostManifest=process.env.DYOFFICE_TEST_HOST_MANIFEST

test('XLSX lists, preserves and breaks external workbook links without fetching the source',{skip:!sheetsDirectory,timeout:150000},async t=>{
 let app,externalRequests=0
 const server=createServer((request,response)=>{
  if(request.url?.split('?')[0]==='/linked-source.xlsx'){
   externalRequests++
   response.writeHead(404).end()
   return
  }
  app.routing(request,response)
 })
 t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve))})
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 const origin='http://127.0.0.1:'+server.address().port
 const externalTarget=origin+'/linked-source.xlsx?year=2026&unit=CNY'
 const f=await fileFixture(t,{origin,buildApp:false})
 await f.preferences.update(f.alice.token,{language:'en',autoSave:false})

 const directory=await mkdtemp(join(tmpdir(),'dyoffice-external-xlsx-'))
 f.cleanup.push(()=>rm(directory,{recursive:true,force:true}))
 await buildSheetsGateway(join(directory,'gateway.mjs'))
 const native=hostManifest ? JSON.parse(await readFile(hostManifest,'utf8')) : null
 if(native)assert.ok(native.nativeBinary&&native.nativeSha256,'The host manifest must describe a native XLSX binary')
 const runtime=await configuredSheetsRuntime({
  DYOFFICE_AUTH_MODE:'local',DYOFFICE_DEPLOYMENT_ID:f.deploymentId,
  ...(native ? {
   DYOFFICE_NATIVE_BINARY:native.nativeBinary,DYOFFICE_NATIVE_SHA256:native.nativeSha256,
  } : {
   DYOFFICE_SANDBOX_MODE:'subprocess',DYOFFICE_XLSX_NODE_ENGINE:join(directory,'xlsx-node-engine.mjs'),
  }),
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
 zip.file(linkRelationships,`<Relationships xmlns="${packageRelationshipNamespace}"><Relationship Id="rId1" Type="${relationshipNamespace}/externalLinkPath" Target="${externalTarget.replace('&','&amp;')}" TargetMode="External"/></Relationships>`)
 const original=await zip.generateAsync({type:'nodebuffer'})
 const initial=(await importFile(f,f.alice.token,original,'external-reference.xlsx')).file
 app=await buildLocalApp({
  db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,
  csrfKey:f.csrfKey,objectStore:f.objects,codingHarnesses:false,
  localShellDirectory:process.env.DYOFFICE_TEST_LOCAL_SHELL_DIRECTORY,...runtime,
 })
 f.cleanup.unshift(()=>app.close())
 await app.ready()
 const csrf=createCsrfService({db:f.db,deploymentId:f.deploymentId,origin,key:f.csrfKey})
 const readLinks=(token,payload={revision:initial.revision})=>app.inject({
  method:'POST',url:`/api/v1/files/${initial.fileId}/sheets/external-links`,payload,
  headers:{origin,cookie:SESSION_COOKIE+'='+token,'x-csrf-token':csrf.sessionToken(token)},
 })
 assert.equal((await readLinks(f.bob.token)).statusCode,404)
 assert.equal((await readLinks(f.alice.token,{revision:initial.revision,path:'/tmp/foreign.xlsx'})).statusCode,400)
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
 const openExternalLinks=async()=>{
  await page.getByRole('button',{name:'Formulas',exact:true}).click()
  const result=page.waitForResponse(response=>response.url().endsWith('/sheets/external-links'),{timeout:20000})
  await page.getByRole('button',{name:'External Links',exact:true}).click()
  const response=await result
  assert.ok(response.ok(),await response.text())
  const panel=page.getByRole('dialog',{name:'External Links',exact:true})
  await expect(panel.getByRole('cell',{name:externalTarget,exact:true})).toBeVisible({timeout:12000})
  await expect(panel.getByRole('cell',{name:'Catalog',exact:true})).toBeVisible()
  await expect(panel.getByRole('button',{name:'Update',exact:true})).toHaveCount(0)
  return panel
 }
 const panel=await openExternalLinks()
 assert.equal(externalRequests,0)
 await panel.locator('.watch-close').click()
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
 const reopenedPanel=await openExternalLinks()
 const revisionCount=()=>f.transactions.withPrincipalTransaction({kind:'session',token:f.alice.token},async connection=>
  (await connection.query('SELECT count(*)::int AS count FROM file_revisions WHERE file_id=$1',[initial.fileId])).rows[0].count)
 const countBeforeBreak=await revisionCount()
 await reopenedPanel.getByRole('button',{name:'Break Link',exact:true}).click()
 assert.equal((await f.files.openFile(f.alice.token,initial.fileId)).file.revision,head.revision)
 const saveResponses=[]
 page.on('response',response=>{
  const path=new URL(response.url()).pathname
  const route=path.endsWith('/sheets/uploads')?'prepare':path.endsWith('/commits')?'commit':null
  if(route&&response.request().method()==='POST')saveResponses.push([route,response.status()])
 })
 const commit=page.waitForResponse(response=>response.request().method()==='POST'&&
   response.url().endsWith(`/files/${initial.fileId}/commits`),{timeout:30000})
 const [result]=await Promise.all([
  commit,
  reopenedPanel.getByRole('button',{name:'Confirm break',exact:true}).click(),
 ]).catch(error=>{
  t.diagnostic(`Break Link save responses: ${JSON.stringify(saveResponses)}`)
  throw error
 })
 assert.ok(result.ok(),await result.text())
 const {revision}=await result.json()
 assert.notEqual(revision,head.revision)
 await expect(reopenedPanel.getByText('This workbook has no links to other workbooks.',{exact:true})).toBeVisible({timeout:30000})
 const readExternalCell=()=>page.evaluate(()=>{
  const cell=window.__genofficeDebug?.univerAPI.getActiveWorkbook()?.getActiveSheet()?.getRange('G3')
  return {value:cell?.getValue(),formula:cell?.getFormula()??''}
 })
 await expect.poll(readExternalCell,{timeout:30000}).toEqual({value:84,formula:''})
 const broken=await JSZip.loadAsync(await f.files.readFile(f.alice.token,initial.fileId,revision))
 assert.equal(broken.file(link),null)
 assert.equal(broken.file(linkRelationships),null)
 assert.ok(!(await broken.file(book).async('string')).includes(reference))
 assert.ok(!(await broken.file(bookRelationships).async('string')).includes(relationship))
 assert.match(await broken.file(worksheet).async('string'),/<c r="G3"><v>84<\/v><\/c>/)
 assert.deepEqual(bytes,await f.files.readFile(f.alice.token,initial.fileId,head.revision))
 assert.equal(await revisionCount(),countBeforeBreak+1)
 await page.reload()
 await expect.poll(localAmount,{timeout:30000}).toBe(21.25)
 await expect.poll(readExternalCell,{timeout:30000}).toEqual({value:84,formula:''})
 assert.equal(externalRequests,0)
})
