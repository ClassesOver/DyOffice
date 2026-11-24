import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {EventEmitter} from 'node:events'
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
import {objectTransferAdmission} from '../../server/src/modules/files/transfer-admission.ts'

const sheetsDirectory=process.env.DYOFFICE_TEST_SHEETS_DIST
const hostManifest=process.env.DYOFFICE_TEST_HOST_MANIFEST
const wasiRunner=process.env.DYOFFICE_TEST_XLSX_WASI_REFRESH_RUNNER
const engine=process.env.DYOFFICE_TEST_XLSX_EXTERNAL_ENGINE
const modes=engine ? [engine] : [
 ...(hostManifest?['rust','hybrid']:[]),
 ...(wasiRunner?['wasi']:[]),
 ...(!hostManifest&&!wasiRunner?['node']:[]),
]

for(const mode of modes)test(mode!=='node'
 ?`XLSX (${mode}) preserves external formulas while relinking, refreshing and breaking workbook links`
 :'XLSX lists, preserves and breaks workbook links without fetching the source',
{skip:!sheetsDirectory,timeout:180000},async t=>{
 let app,externalRequests=0,downloadRevision
 const downloadStatuses=[]
 const server=createServer((request,response)=>{
  if(request.url?.split('?')[0]==='/linked-source.xlsx'){
   externalRequests++
   response.writeHead(404).end()
   return
  }
  const url=new URL(request.url,'http://localhost')
  if(downloadRevision&&request.method==='GET'&&url.pathname.endsWith('/content')&&url.searchParams.get('revision')===downloadRevision){
   response.on('finish',()=>downloadStatuses.push(response.statusCode))
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
 const native=mode==='rust'||mode==='hybrid' ? JSON.parse(await readFile(hostManifest,'utf8')) : null
 if(native)assert.ok(native.nativeBinary&&native.nativeSha256,'The host manifest must describe a native XLSX binary')
 const refreshAvailable=Boolean(native||mode==='wasi')
 const runtime=await configuredSheetsRuntime({
  DYOFFICE_AUTH_MODE:'local',DYOFFICE_DEPLOYMENT_ID:f.deploymentId,
  ...(native && {
   DYOFFICE_NATIVE_BINARY:native.nativeBinary,DYOFFICE_NATIVE_SHA256:native.nativeSha256,
  }),
  ...(mode!=='rust' ? {
   DYOFFICE_XLSX_NODE_ENGINE:join(directory,'xlsx-node-engine.mjs'),
  } : {}),
  ...(mode==='hybrid'?{DYOFFICE_SANDBOX_MODE:'subprocess'}:{}),
  ...(mode==='wasi'?{DYOFFICE_XLSX_WASI_REFRESH_RUNNER:wasiRunner}:{}),
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
 const sourceZip=await JSZip.loadAsync(await readFile(new URL('../fixtures/sheets/acceptance.xlsx',import.meta.url)))
 sourceZip.file(book,(await sourceZip.file(book).async('string')).replaceAll('Acceptance','Catalog'))
 sourceZip.file(worksheet,(await sourceZip.file(worksheet).async('string')).replace(
  '<c r="A1" t="inlineStr"><is><t>Revenue</t></is></c>','<c r="A1"><v>37</v></c>'))
 const sourceBytes=await sourceZip.generateAsync({type:'nodebuffer'})
 const source=(await importFile(f,f.alice.token,sourceBytes,'Source catalog.xlsx')).file
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
 const notifications=page.getByRole('complementary',{name:'Document notifications'})
 const assistantWarning=notifications.getByText(/No model is available for AI assistant/)
 await expect(assistantWarning).toBeVisible()
 await page.evaluate(()=>{
  const workbook=window.__genofficeDebug.univerAPI.getActiveWorkbook()
  workbook.setActiveRange(workbook.getActiveSheet().getRange('H3'))
 })
 await page.getByRole('button',{name:'Formulas',exact:true}).click()
 await page.getByRole('button',{name:/Insert Function/}).click()
 const functionCatalog=page.getByRole('dialog',{name:'Insert Function',exact:true})
 await functionCatalog.getByPlaceholder('Search functions…').fill('SUM')
 await functionCatalog.getByRole('option',{name:/^SUM\(/}).click()
 const [argumentLinks]=await Promise.all([
  page.waitForResponse(response=>response.url().endsWith('/sheets/external-links'),{timeout:20000}),
  functionCatalog.getByRole('button',{name:'OK',exact:true}).click(),
 ])
 assert.ok(argumentLinks.ok(),`Function argument link list returned HTTP ${argumentLinks.status()}`)
 const args=page.getByRole('dialog',{name:'Function Arguments',exact:true})
 await expect(args.getByText('Linked workbooks',{exact:true})).toBeVisible()
 const linkedBook=args.locator('.fn-args-external-row').filter({hasText:'linked-source.xlsx'})
 await expect(linkedBook.getByRole('combobox')).toHaveValue('Catalog')
 await linkedBook.getByPlaceholder('A1:B2').fill('A1:A2')
 await linkedBook.getByRole('button',{name:'Insert',exact:true}).click()
 await expect(args.locator('#fn-arg-0')).toHaveValue('[1]Catalog!A1:A2')
 await args.getByRole('button',{name:'OK',exact:true}).click({timeout:5000})
 await expect(args).toBeHidden()
 await expect(assistantWarning).toBeVisible()
 await notifications.getByRole('button',{name:/^Notifications \(/}).click()
 await expect(assistantWarning).toBeHidden()
 const readInsertedFormula=()=>page.evaluate(()=>
  window.__genofficeDebug?.univerAPI.getActiveWorkbook()?.getActiveSheet()?.getRange('H3').getFormula())
 await expect.poll(readInsertedFormula).toBe('=SUM([1]Catalog!A1:A2)')
 assert.equal(externalRequests,0)
 const openExternalLinks=async()=>{
  const command=page.getByRole('button',{name:'External Links',exact:true})
  if(!await command.isVisible())await page.getByRole('button',{name:'Formulas',exact:true}).click()
  const [response]=await Promise.all([
   page.waitForResponse(response=>response.url().endsWith('/sheets/external-links'),{timeout:20000}),
   command.click(),
  ])
  assert.ok(response.ok(),`External link list returned HTTP ${response.status()}`)
  const panel=page.getByRole('dialog',{name:'External Links',exact:true})
  await expect(panel.getByRole('cell',{name:externalTarget,exact:true})).toBeVisible({timeout:12000})
  await expect(panel.getByRole('cell',{name:'Catalog',exact:true})).toBeVisible()
  await expect(panel.getByRole('button',{name:'Update Values',exact:true})).toHaveCount(refreshAvailable?1:0)
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
 const worksheetXml=await saved.file(worksheet).async('string')
 assert.ok(worksheetXml.includes(formula))
 assert.ok(worksheetXml.includes('<f>SUM([1]Catalog!A1:A2)</f>'))
 for(const part of [link,linkRelationships]){
  assert.deepEqual(await saved.file(part).async('nodebuffer'),await zip.file(part).async('nodebuffer'))
 }
 const head=(await f.files.openFile(f.alice.token,initial.fileId)).file
 assert.notEqual(head.revision,initial.revision)
 assert.deepEqual(bytes,await f.files.readFile(f.alice.token,head.fileId,head.revision))
 assert.deepEqual(original,await f.files.readFile(f.alice.token,initial.fileId,initial.revision))
 await page.reload()
 await expect.poll(localAmount,{timeout:30000}).toBe(21.25)
 await expect.poll(readInsertedFormula).toBe('=SUM([1]Catalog!A1:A2)')
 const reopenedPanel=await openExternalLinks()
 const revisionCount=()=>f.transactions.withPrincipalTransaction({kind:'session',token:f.alice.token},async connection=>
  (await connection.query('SELECT count(*)::int AS count FROM file_revisions WHERE file_id=$1',[initial.fileId])).rows[0].count)
 let beforeBreak=head,expectedValue=84
 if(refreshAvailable){
  const beforeSourceChange=await revisionCount()
  await reopenedPanel.getByRole('button',{name:'Change Source',exact:true}).click()
  await reopenedPanel.getByRole('combobox',{name:'Source',exact:true}).selectOption({label:'Source catalog.xlsx'})
  await reopenedPanel.getByRole('button',{name:'Save',exact:true}).click()
  await expect.poll(revisionCount,{timeout:20000}).toBe(beforeSourceChange+1)
  const changed=(await f.files.openFile(f.alice.token,initial.fileId)).file
  const savedSource=await JSZip.loadAsync(await f.files.readFile(f.alice.token,initial.fileId,changed.revision))
  const sourceTarget=origin+'/api/v1/files/'+source.fileId+'/content?revision='+source.revision
  assert.ok((await savedSource.file(linkRelationships).async('string')).includes(`Target="${sourceTarget}"`))
  assert.ok((await savedSource.file(worksheet).async('string')).includes(formula))
  await expect(reopenedPanel.getByRole('cell',{name:'Source catalog.xlsx',exact:true})).toBeVisible()
  let openedSource
  await expect.poll(async()=>{
   openedSource=await app.inject({method:'GET',url:sourceTarget,headers:{cookie:SESSION_COOKIE+'='+f.alice.token}})
   return openedSource.statusCode
  },{timeout:12000}).toBe(200)
  assert.deepEqual(openedSource.rawPayload,sourceBytes)
  const preview=page.waitForResponse(response=>response.url().endsWith('/sheets/external-links/preview'),{timeout:20000})
  await reopenedPanel.getByRole('button',{name:'Update Values',exact:true}).click()
  const previewResult=await preview
  assert.ok(previewResult.ok(),`External link preview returned HTTP ${previewResult.status()}`)
  await expect.poll(revisionCount,{timeout:20000}).toBe(beforeSourceChange+2)
  beforeBreak=(await f.files.openFile(f.alice.token,initial.fileId)).file
  const refreshedBytes=await f.files.readFile(f.alice.token,initial.fileId,beforeBreak.revision)
  const refreshed=await JSZip.loadAsync(refreshedBytes)
  assert.match(await refreshed.file(worksheet).async('string'),/<c r="G3"><f>\[1\]Catalog!\$A\$1<\/f><v>37<\/v><\/c>/)
  const admission=objectTransferAdmission(app),admit=admission.admit
  const occupying=[{raw:new EventEmitter()},{raw:new EventEmitter()}]
  const release=()=>occupying.forEach(request=>admission.close(request))
  await expect.poll(()=>{
   try{
    for(const request of occupying)admit(request,{raw:new EventEmitter()})
    return true
   }catch(error){
    release()
    if(error.statusCode!==503)throw error
    return false
   }
  },{timeout:12000}).toBe(true)
  try{
   const normalRead=await app.inject({method:'GET',url:sourceTarget,headers:{cookie:SESSION_COOKIE+'='+f.alice.token}})
   assert.equal(normalRead.statusCode,503)
   downloadRevision=beforeBreak.revision
   t.mock.method(admission,'admit',(request,...args)=>{
    try{return admit(request,...args)}
    finally{if(request.method==='GET'&&request.query?.revision===downloadRevision)release()}
   })
   const [download]=await Promise.all([page.waitForEvent('download',{timeout:30000}),save.click()])
   const downloaded=await download.path().catch(error=>{
    t.diagnostic('Confirmed XLSX download HTTP responses: '+JSON.stringify(downloadStatuses))
    throw error
   })
   assert.deepEqual(await readFile(downloaded),refreshedBytes)
   assert.deepEqual(downloadStatuses,[200])
  }finally{
   release()
   t.mock.restoreAll()
  }
  assert.equal(await revisionCount(),beforeSourceChange+2)
  await page.reload()
  await expect.poll(()=>page.evaluate(()=>
   window.__genofficeDebug?.univerAPI.getActiveWorkbook()?.getActiveSheet()?.getRange('G3').getValue()),
  {timeout:30000}).toBe(37)
  await page.getByRole('button',{name:'Formulas',exact:true}).click()
  await page.getByRole('button',{name:'External Links',exact:true}).click()
  await expect(reopenedPanel.getByRole('cell',{name:'Source catalog.xlsx',exact:true})).toBeVisible()
  expectedValue=37
 }
 const countBeforeBreak=await revisionCount()
 await reopenedPanel.getByRole('button',{name:'Break Link',exact:true}).click()
 assert.equal((await f.files.openFile(f.alice.token,initial.fileId)).file.revision,beforeBreak.revision)
 let refreshFailures=0
 await page.route('**/sheets/external-links',route=>{
  refreshFailures++
  return route.fulfill({status:503,json:{error:'Unavailable'}})
 },{times:1})
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
 assert.ok(result.ok(),`External link break commit returned HTTP ${result.status()}`)
 const {revision}=(await f.files.openFile(f.alice.token,initial.fileId)).file
 assert.notEqual(revision,beforeBreak.revision)
 await expect(reopenedPanel.getByText('External Links: failed to read',{exact:true})).toBeVisible({timeout:15000})
 assert.equal(refreshFailures,1)
 await expect(reopenedPanel.getByText('This workbook has no links to other workbooks.',{exact:true})).toHaveCount(0)
 await reopenedPanel.locator('button.watch-close').click()
 const linkCommand=page.getByRole('button',{name:'External Links',exact:true})
 if(!await linkCommand.isVisible())await page.getByRole('button',{name:'Formulas',exact:true}).click()
 const [reread]=await Promise.all([
  page.waitForResponse(response=>response.url().endsWith('/sheets/external-links'),{timeout:15000}),
  linkCommand.click(),
 ])
 assert.ok(reread.ok(),`External link list retry returned HTTP ${reread.status()}`)
 await expect(reopenedPanel.getByText('This workbook has no links to other workbooks.',{exact:true})).toBeVisible({timeout:15000})
 const readExternalCell=()=>page.evaluate(()=>{
  const cell=window.__genofficeDebug?.univerAPI.getActiveWorkbook()?.getActiveSheet()?.getRange('G3')
  return {value:cell?.getValue(),formula:cell?.getFormula()??''}
 })
 await expect.poll(readExternalCell,{timeout:30000}).toEqual({value:expectedValue,formula:''})
 const broken=await JSZip.loadAsync(await f.files.readFile(f.alice.token,initial.fileId,revision))
 assert.equal(broken.file(link),null)
 assert.equal(broken.file(linkRelationships),null)
 assert.ok(!(await broken.file(book).async('string')).includes(reference))
 assert.ok(!(await broken.file(bookRelationships).async('string')).includes(relationship))
 assert.ok((await broken.file(worksheet).async('string')).includes(`<c r="G3"><v>${expectedValue}</v></c>`))
 assert.deepEqual(bytes,await f.files.readFile(f.alice.token,initial.fileId,head.revision))
 assert.equal(await revisionCount(),countBeforeBreak+1)
 await page.reload()
 await expect.poll(localAmount,{timeout:30000}).toBe(21.25)
 await expect.poll(readExternalCell,{timeout:30000}).toEqual({value:expectedValue,formula:''})
 assert.equal(externalRequests,0)
})
