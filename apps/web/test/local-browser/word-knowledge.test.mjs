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
async function document(text,extraBody=''){const zip=await JSZip.loadAsync(await docxBytes());zip.file('word/document.xml',`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p>${extraBody}<w:sectPr/></w:body></w:document>`);return zip.generateAsync({type:'nodebuffer'})}

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
 const pendingRevisions='<w:p><w:ins w:id="1" w:author="Reviewer"><w:r><w:t>Keep pending insertion</w:t></w:r></w:ins></w:p>'+
  '<w:p><w:ins w:id="2" w:author="Reviewer"><w:r><w:t>Drop pending insertion</w:t></w:r></w:ins></w:p>'
 const draftBytes=await document('Working document remains unchanged',liveConfig?'':pendingRevisions),draft=(await importFile(f,f.alice.token,draftBytes,'工作文档.docx')).file
 if(!liveConfig)await f.preferences.update(f.alice.token,{autoSave:false})
 await createWorkspaceService(f.transactions).setStar(f.alice.token,source.fileId,{starred:true})
 const sourcePath=`/files/${source.fileId}/revisions/${source.revision}/${encodeURIComponent('参考资料.docx')}`,cite=kbCiteHref(sourcePath),wire=[];let turn=0
 if(!liveConfig){const network=mockProviderNetwork(t,()=>{
  const request=JSON.parse(network.wire.toString())
  const user=request.messages.findLastIndex(message=>message.role==='user')
  const content=request.messages[user]?.content
  const prompt=typeof content==='string'?content:content?.map(part=>part.text??'').join(' ')
  if(prompt?.includes('验证替换正文')||prompt?.includes('验证替换选区')){
   const selection=prompt.includes('验证替换选区')
   const results=request.messages.slice(user+1).filter(message=>message.role==='tool').map(message=>JSON.parse(message.content))
   const calls=selection
    ? [['replace_selection',{html:'<strong>approved</strong>'},/Replaced the selected text.*"draft".*"approved"/]]
    : [['insert_content',{afterBlockIndex:0,html:'<p>Draft block 651</p>'},/Inserted 1 block/],
      ['replace_blocks',{startBlockIndex:1,endBlockIndex:1,html:'<p>Begin draft report</p>'},/Replaced blocks 1-1/]]
   if(results.length){
    const {output,isError}=results.at(-1),[name,,expected]=calls[results.length-1]
    assert.ok(!isError,name+': '+output)
    assert.match(output,expected,name+': '+output)
   }
   const action=calls[results.length]
   const delta=action?{tool_calls:[{index:0,id:'replace-'+action[0],type:'function',function:{name:action[0],arguments:JSON.stringify(action[1])}}]}:{content:selection?'已验证替换选区':'已验证替换正文'}
   return Readable.from([Buffer.from(`data: ${JSON.stringify({choices:[{delta,finish_reason:action?'tool_calls':'stop'}]})}\n\ndata: [DONE]\n\n`)])
  }
  if(prompt?.includes('验证批注与修订')){
   const results=request.messages.slice(user+1).filter(message=>message.role==='tool').map(message=>JSON.parse(message.content))
   const keepId=results[3]?.output.match(/Added comment (\d+)/)?.[1]
   const dropId=results[6]?.output.match(/Added comment (\d+)/)?.[1]
   const calls=[
    ['read_revisions',{},/r1[^\n]*Keep pending insertion[\s\S]*r2[^\n]*Drop pending insertion/],
    ['reject_changes',{ids:['r2']},/Rejected 1 tracked change/],
    ['accept_changes',{ids:['r1']},/No tracked changes remain/],
    ['add_comment',{blockIndex:0,text:'Working document',comment:'Retain review thread'},/Added comment/],
    ['reply_comment',{parentId:keepId,text:'Verified review reply'},/Replied to comment/],
    ['resolve_comment',{id:keepId},/marked as resolved/],
    ['add_comment',{blockIndex:0,text:'unchanged',comment:'Temporary review thread'},/Added comment/],
    ['delete_comment',{id:dropId},/Deleted comment/],
    ['read_comments',{},/Retain review thread[\s\S]*Verified review reply/],
   ]
   if(results.length){
    const {output,isError}=results.at(-1),[name,,expected]=calls[results.length-1]
    assert.ok(!isError,name+': '+output)
    assert.match(output,expected,name+': '+output)
   }
   if(results.length===calls.length){
    assert.match(results.at(-1).output,/\[resolved\]/)
    assert.doesNotMatch(results.at(-1).output,/Temporary review thread/)
   }
   const action=calls[results.length]
   const delta=action?{tool_calls:[{index:0,id:'review-'+results.length,type:'function',function:{name:action[0],arguments:JSON.stringify(action[1])}}]}:{content:'已验证批注与修订'}
   return Readable.from([Buffer.from(`data: ${JSON.stringify({choices:[{delta,finish_reason:action?'tool_calls':'stop'}]})}\n\ndata: [DONE]\n\n`)])
  }
  if(prompt?.includes('验证页面与样式')){
   const results=request.messages.slice(user+1).filter(message=>message.role==='tool')
   const calls=[
    ['get_document_context',{},/Working document/],
    ['read_blocks',{startBlockIndex:0,endBlockIndex:0},/Working document/],
    ['insert_section_break',{afterBlockIndex:0,type:'continuous'},/Inserted a continuous section break/],
    ['set_page_setup',{paper:'A5',orientation:'landscape'},/A5 landscape/],
    ['set_header_footer',{kind:'header',text:'Audit header 651'},/Updated the header/],
    ['define_style',{styleId:'AuditCallout',name:'Audit Callout',type:'paragraph',run:{bold:true}},/Created style AuditCallout/],
    ['list_styles',{},/AuditCallout/],
    ['apply_ops',{ops:[{op:'applyStyle',target:{blockIndexes:[0]},styleId:'AuditCallout'}]},/applyStyle/i],
    ['insert_chart',{afterBlockIndex:0,kind:'bar',title:'Draft chart',categories:['East','West'],series:[{name:'Sample',values:[8,13]}]},/Inserted a bar chart/],
    ['edit_chart',{blockIndex:1,title:'Audit chart',series:[{index:0,name:'Fixture series',values:[21,34]}]},/Updated the data of chart "Audit chart"/],
    ['insert_text_box',{afterBlockIndex:1,text:'Floating callout 651',width:'5cm',height:'2cm',x:0,y:12},/Inserted a .* text box/],
    ['set_watermark',{text:'DRAFT 651'},/Watermark set to "DRAFT 651"/],
   ]
   if(results.length){
    const {output,isError}=JSON.parse(results.at(-1).content)
    const [name,,expected]=calls[results.length-1]
    assert.ok(!isError,name+': '+output)
    assert.match(output,expected,name+': '+output)
   }
   const action=calls[results.length]
   const delta=action?{tool_calls:[{index:0,id:'layout-'+action[0],type:'function',function:{name:action[0],arguments:JSON.stringify(action[1])}}]}:{content:'已验证页面与样式'}
   return Readable.from([Buffer.from(`data: ${JSON.stringify({choices:[{delta,finish_reason:action?'tool_calls':'stop'}]})}\n\ndata: [DONE]\n\n`)])
  }
  if(prompt?.includes('验证脚注与尾注')){
   const results=request.messages.slice(user+1).filter(message=>message.role==='tool')
   const outputs=results.map(({content})=>JSON.parse(content))
   assert.ok(outputs.every(({isError})=>isError!==true))
   const originalId=outputs[0]?.output.match(/Inserted footnote (\d+)/)?.[1]
   const temporaryId=outputs[2]?.output.match(/Inserted footnote (\d+)/)?.[1]
   const calls=[
    ['insert_footnote',{blockIndex:0,afterText:'Working document',text:'Intake draft'}],
    ['insert_endnote',{blockIndex:0,text:'Release source'}],
    ['insert_footnote',{blockIndex:0,afterText:'remains',text:'Temporary note'}],
    ['edit_note',{kind:'footnote',id:originalId,find:'draft',replace:'final'}],
    ['delete_note',{kind:'footnote',id:temporaryId}],
    ['read_notes',{}],
   ]
   const action=calls[results.length]
   if(results.length>=3){assert.ok(originalId);assert.ok(temporaryId);assert.notEqual(originalId,temporaryId)}
   if(!action){
    const {output}=outputs.at(-1)
    assert.match(output,/Intake final/)
    assert.match(output,/Release source/)
    assert.doesNotMatch(output,/Temporary note/)
   }
   const delta=action?{tool_calls:[{index:0,id:'notes-'+results.length,type:'function',function:{name:action[0],arguments:JSON.stringify(action[1])}}]}:{content:'已验证脚注与尾注'}
   return Readable.from([Buffer.from(`data: ${JSON.stringify({choices:[{delta,finish_reason:action?'tool_calls':'stop'}]})}\n\ndata: [DONE]\n\n`)])
  }
  wire.push(request)
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
 if(!liveConfig){
  await composer.fill('验证批注与修订');await composer.press('Enter')
  await expect(editor.locator('.ai-msg-assistant').last()).toContainText('已验证批注与修订',{timeout:45000})
  await expect(editor.locator('.ai-msg-streaming')).toHaveCount(0)
  await composer.fill('验证脚注与尾注');await composer.press('Enter')
  await expect(editor.locator('.ai-msg-assistant').last()).toContainText('已验证脚注与尾注',{timeout:45000})
  await expect(editor.locator('.ai-msg-streaming')).toHaveCount(0)
  await composer.fill('验证页面与样式');await composer.press('Enter')
  await expect(editor.locator('.ai-msg-assistant').last()).toContainText('已验证页面与样式',{timeout:45000})
  await expect(editor.locator('.ai-msg-streaming')).toHaveCount(0)
  await composer.fill('验证替换正文');await composer.press('Enter')
  await expect(editor.locator('.ai-msg-assistant').last()).toContainText('已验证替换正文',{timeout:45000})
  const rewritten=editor.locator('.tiptap.doc-page p').filter({hasText:/^Begin draft report$/})
  await rewritten.evaluate(paragraph=>{
   const text=paragraph.ownerDocument.createTreeWalker(paragraph,NodeFilter.SHOW_TEXT).nextNode()
   const range=paragraph.ownerDocument.createRange()
   range.setStart(text,6)
   range.setEnd(text,11)
   paragraph.closest('.tiptap').focus()
   const selection=paragraph.ownerDocument.getSelection()
   selection.removeAllRanges()
   selection.addRange(range)
  })
  await expect.poll(()=>rewritten.evaluate(node=>node.ownerDocument.getSelection().toString())).toBe('draft')
  await composer.fill('验证替换选区');await composer.press('Enter')
  await expect(editor.locator('.ai-msg-assistant').last()).toContainText('已验证替换选区',{timeout:45000})
  const head=async()=>(await f.files.openFile(f.alice.token,draft.fileId)).file.revision
  const readSaved=async()=>JSZip.loadAsync(await f.files.readFile(f.alice.token,draft.fileId,await head()))
  await page.keyboard.press('Control+s')
  await expect.poll(async()=>{
   const snapshot=await readSaved()
   const xml=await snapshot.file('word/document.xml').async('string')
   return /<w:pgSz[^>]*w:orient="landscape"/.test(xml)
  },{timeout:30000}).toBe(true)
  const saved=await readSaved()
  const footnotes=await saved.file('word/footnotes.xml').async('string')
  const endnotes=await saved.file('word/endnotes.xml').async('string')
  const body=await saved.file('word/document.xml').async('string')
  assert.match(footnotes,/Intake final/)
  assert.doesNotMatch(footnotes,/Intake draft|Temporary note/)
  assert.match(endnotes,/Release source/)
  assert.equal((body.match(/<w:footnoteReference\b/g)??[]).length,1)
  assert.equal((body.match(/<w:endnoteReference\b/g)??[]).length,1)
  assert.match(body,/<w:type w:val="continuous"/)
  assert.match(body,/<w:pgSz[^>]*w:orient="landscape"/)
  const headers=await Promise.all(saved.file(/^word\/header[0-9]+\.xml$/).map(part=>part.async('string')))
  assert.ok(headers.some(header=>header.includes('Audit header 651')))
  assert.ok(headers.some(header=>header.includes('DRAFT 651')))
  assert.match(await saved.file('word/styles.xml').async('string'),/w:styleId="AuditCallout"/)
  assert.match(body,/<w:pStyle w:val="AuditCallout"/)
  assert.match(body,/<w:txbxContent>[\s\S]*Floating callout 651/)
  assert.match(body,/<w:commentRangeStart\b/)
  const [chart]=await Promise.all(saved.file(/^word\/charts\/chart\d+\.xml$/).map(part=>part.async('string')))
  assert.match(chart,/Audit chart/)
  assert.match(chart,/Fixture series/)
  assert.match(chart,/<c:v>21<\/c:v>[\s\S]*<c:v>34<\/c:v>/)
  const comments=await saved.file('word/comments.xml').async('string')
  const commentThreads=await saved.file('word/commentsExtended.xml').async('string')
  assert.match(comments,/Retain review thread[\s\S]*Verified review reply/)
  assert.doesNotMatch(comments,/Temporary review thread/)
  assert.equal((commentThreads.match(/w15:done="1"/g)??[]).length,2)
  assert.match(commentThreads,/w15:paraIdParent="[A-F0-9]+"/i)
  assert.match(body,/Keep pending insertion/)
  assert.doesNotMatch(body,/Drop pending insertion|<w:ins\b/)
  assert.match(body,/Begin <\/w:t>[\s\S]*?<w:t[^>]*>approved<\/w:t>[\s\S]*? report<\/w:t>/)
  assert.doesNotMatch(body,/Draft block 651/)
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
