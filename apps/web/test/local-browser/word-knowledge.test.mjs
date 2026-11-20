import {stubHomeHero} from '../helpers/home-hero.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import {randomBytes} from 'node:crypto'
import {Readable} from 'node:stream'
import {mkdir,readFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import JSZip from 'jszip'
import {expect} from '@playwright/test'
import {launchTestBrowser} from '../helpers/browser.mjs'
import {fileFixture,docxBytes,importFile} from '../helpers/files.mjs'
import {password} from '../helpers/identity.mjs'
import {mockProviderNetwork} from '../helpers/provider-network.mjs'
import {buildLocalApp} from '../../server/src/app.ts'
import {createWorkspaceService} from '../../server/src/modules/workspace/service.ts'
import {createGlobalConfigService} from '../../server/src/modules/admin/service.ts'
import {kbCiteHref} from '../../../../packages/agent-core/src/knowledge-base-skill.ts'
async function document(text){const zip=await JSZip.loadAsync(await docxBytes());zip.file('word/document.xml',`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`);return zip.generateAsync({type:'nodebuffer'})}

const liveConfig=process.env.DYOFFICE_LIVE_WORD_KNOWLEDGE_CONFIG
test('Word searches a starred saved source, reads its actual text and opens the cited workspace file'+(liveConfig?' with a real model':''),{timeout:180000},async t=>{
 let app,browser;t.after(async()=>{await browser?.close();app?.server.closeAllConnections();await app?.close()})
 const origin='http://127.0.0.1:4291',f=await fileFixture(t,{origin,buildApp:false}),keyring={activeKeyId:'word-kb',keys:{'word-kb':new Uint8Array(32).fill(54)}}
 const modelEntry=liveConfig?JSON.parse(await readFile(liveConfig,'utf8')).entry:{id:'shared-chat',kind:'chat',providerId:'deepseek',label:'Test model',model:'synthetic-model',baseUrl:'https://provider.example/v1',enabled:true,apiKey:'synthetic-key'}
 assert.ok(modelEntry?.enabled&&modelEntry?.apiKey&&modelEntry?.kind==='chat','Enabled test model configuration required')
 await createGlobalConfigService({transactions:f.transactions,keyring}).saveGlobalConfig(f.adminSigned.token,0,{upserts:[modelEntry],defaults:{chat:modelEntry.id}})
 const marker=liveConfig?'ORCHID-KB-'+randomBytes(5).toString('hex'):'ORCHID-KB-6419'
 const sourceText='Reference evidence: '+marker
 const sourceBytes=await document(sourceText),source=(await importFile(f,f.alice.token,sourceBytes,'参考资料.docx')).file
 const draftBytes=await document('Working document remains unchanged'),draft=(await importFile(f,f.alice.token,draftBytes,'工作文档.docx')).file
 await createWorkspaceService(f.transactions).setStar(f.alice.token,source.fileId,{starred:true})
 const sourcePath=`/files/${source.fileId}/revisions/${source.revision}/${encodeURIComponent('参考资料.docx')}`,cite=kbCiteHref(sourcePath),wire=[];let turn=0
 if(!liveConfig){const network=mockProviderNetwork(t,()=>{
  wire.push(JSON.parse(network.wire.toString()))
  const step=turn++,tool=step<2,delta=step===0?{tool_calls:[{index:0,id:'kb-search',type:'function',function:{name:'search_knowledge_base',arguments:JSON.stringify({query:'ORCHID-KB-6419'})}}]}:step===1?{tool_calls:[{index:0,id:'kb-read',type:'function',function:{name:'read_knowledge_file',arguments:JSON.stringify({index:0,offset:0})}}]}:{content:`Confirmed reference ORCHID-KB-6419 [参考资料.docx](${cite})`}
  return Readable.from([Buffer.from(`data: ${JSON.stringify({choices:[{delta}]})}\n\ndata: ${JSON.stringify({choices:[{delta:{},finish_reason:tool?'tool_calls':'stop'}]})}\n\ndata: [DONE]\n\n`)])
 })}
 app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,globalConfigKeyring:keyring,providerGateway:{mode:'shared'},codingHarnesses:false,nativeDocsDirectory:process.env.DYOFFICE_TEST_KB_DOCS_DIRECTORY??fileURLToPath(new URL('../../dist-docs',import.meta.url)),localShellDirectory:process.env.DYOFFICE_TEST_LOCAL_SHELL_DIRECTORY??fileURLToPath(new URL('../../dist-local-shell',import.meta.url))})
 await app.listen({host:'127.0.0.1',port:4291});browser=await launchTestBrowser();const page=await browser.newPage({viewport:{width:1440,height:1000}})
 await stubHomeHero(page)
 await page.goto(origin);await page.getByLabel('用户名',{exact:true}).fill('alice');await page.getByLabel('密码',{exact:true}).fill(password)
 await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.locator('.home')).toBeVisible()
 await page.goto(origin+'/#/file/'+draft.fileId)
 const editor=page.frameLocator(`iframe[data-document-id="${draft.fileId}"]`)
 await expect(editor.locator('.tiptap.doc-page').first()).toContainText('Working document remains unchanged',{timeout:45000})
 if(await editor.locator('.ai-rail').isVisible())await editor.locator('.ai-rail').click()
 const composer=editor.locator('.ai-panel textarea')
 const knowledgeCalls=[]
 page.on('response',response=>{
  const path=new URL(response.url()).pathname
  if(response.ok()&&(path==='/api/v1/knowledge/search'||path==='/api/v1/knowledge/read'))knowledgeCalls.push(path)
 })
 await expect(composer).toBeVisible();await composer.fill('请先从收藏知识库搜索 ORCHID，再读取匹配文件的原文，逐字给出完整记录编号，并按工具返回的引用链接标注来源。');await composer.press('Enter')
 const link=editor.locator('.ai-panel a').filter({hasText:'参考资料.docx'})
 await expect(link).toBeVisible({timeout:90000});assert.equal(await link.getAttribute('href'),cite)
 assert.ok(knowledgeCalls.includes('/api/v1/knowledge/search'))
 assert.ok(knowledgeCalls.includes('/api/v1/knowledge/read'))
 if(liveConfig){
  await expect(editor.locator('.ai-msg-assistant').last()).toContainText(marker)
  await expect(editor.locator('.ai-msg-streaming')).toHaveCount(0,{timeout:30000})
  await expect(editor.locator('.ai-msg-error')).toHaveCount(0)
 }else{
 assert.equal(wire.length,3)
 const offered=wire[0].tools.map(tool=>tool.function?.name??tool.name);assert.ok(offered.includes('search_knowledge_base'));assert.ok(offered.includes('read_knowledge_file'))
 const result=wire[2].messages.filter(message=>message.role==='tool').at(-1)
 assert.match(result.content,/Reference evidence: ORCHID-KB-6419/)
 await mkdir('test-results/office-dock-unified',{recursive:true})
 for(const theme of ['light','dark']){
  await editor.locator('html').evaluate((node,theme)=>node.dataset.theme=theme,theme)
  const summary=editor.locator('.ai-work-group-summary').first()
  if(await summary.getAttribute('aria-expanded')!=='true')await summary.click()
  const step=editor.locator('.ai-step-title.clickable').first()
  if(await step.getAttribute('aria-expanded')!=='true')await step.click()
  await expect(editor.locator('.ai-tool-output').first()).toBeVisible()
  assert.ok(await editor.locator('.ai-chat').evaluate(node=>node.scrollWidth<=node.clientWidth+1),'tool history fits the conversation viewport')
  await summary.focus();await expect(summary).toBeFocused()
  await editor.locator('.ai-panel').screenshot({path:`test-results/office-dock-unified/docx-tool-history-${theme}.png`,animations:'disabled'})
  await link.focus();await expect(link).toBeFocused()
  await link.scrollIntoViewIfNeeded()
  assert.equal(await link.evaluate(node=>getComputedStyle(node).textDecorationLine),'underline')
  await editor.locator('.ai-panel').screenshot({path:`test-results/office-dock-unified/docx-citation-${theme}.png`,animations:'disabled'})
 }
 }
 await link.click()
 const cited=page.frameLocator(`iframe[data-document-id="${source.fileId}"]`)
 try{
  await expect(cited.locator('.tiptap.doc-page').first()).toContainText(sourceText,{timeout:45000})
 }catch(error){
  const frame=page.frames().find(frame=>new URL(frame.url()).searchParams.get('fileId')===source.fileId)
  t.diagnostic(JSON.stringify({sourceFrame:!!frame,loading:await frame?.locator('html').getAttribute('data-document-loading',{timeout:2000})}))
  throw error
 }
 assert.deepEqual(await f.files.readFile(f.alice.token,draft.fileId,draft.revision),draftBytes)
 assert.deepEqual(await f.files.readFile(f.alice.token,source.fileId,source.revision),sourceBytes)
})
