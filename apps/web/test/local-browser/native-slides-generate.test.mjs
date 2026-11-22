import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {Readable} from 'node:stream'
import {fileURLToPath} from 'node:url'
import {expect} from '@playwright/test'
import JSZip from 'jszip'
import {JSDOM} from 'jsdom'
import {buildLocalApp} from '../../server/src/app.ts'
import {createGlobalConfigService} from '../../server/src/modules/admin/service.ts'
import {createStyleTemplateService} from '../../server/src/modules/style-templates/service.ts'
import {openIsolatedPptxSession} from '../../worker/src/native/pptx-session-host.ts'
import {launchTestBrowser} from '../helpers/browser.mjs'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {password} from '../helpers/identity.mjs'
import {mockProviderNetwork} from '../helpers/provider-network.mjs'

async function savedSlides(bytes){
 const zip=await JSZip.loadAsync(bytes),{window}=new JSDOM()
 try{
  const parser=new window.DOMParser()
  const xml=async path=>parser.parseFromString(await zip.file(path).async('string'),'application/xml')
  const [presentation,relationships]=await Promise.all([xml('ppt/presentation.xml'),xml('ppt/_rels/presentation.xml.rels')])
  const targets=new Map([...relationships.getElementsByTagNameNS('*','Relationship')].map(rel=>[rel.getAttribute('Id'),rel.getAttribute('Target')]))
  return await Promise.all([...presentation.getElementsByTagNameNS('*','sldId')].map(async slide=>{
   const id=slide.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships','id')
   const target=targets.get(id)
   assert.ok(target,'slide relationship resolves to a package part')
   const path=new URL(target,'https://package.invalid/ppt/presentation.xml').pathname.slice(1)
   const source=await zip.file(path).async('string')
   const document=parser.parseFromString(source,'application/xml')
   const text=[...document.getElementsByTagNameNS('*','t')].map(node=>node.textContent)
   const pictures=document.getElementsByTagNameNS('http://schemas.openxmlformats.org/presentationml/2006/main','pic').length
   const background=document.getElementsByTagNameNS('*','bg')[0]?.getElementsByTagNameNS('*','srgbClr')[0]?.getAttribute('val')
   return {source,text,pictures,background}
  }))
 }finally{window.close()}
}

const nativeSlidesDirectory=process.env.DYOFFICE_TEST_SLIDES_DIST
const liveConfig=process.env.DYOFFICE_LIVE_SLIDES_GENERATE_CONFIG
for(const live of [false,true])test(live?'a real model generates, redoes and reuses a saved style in editable PPTX pages':'the PPTX assistant generates a deck and can redo one page without changing its neighbor',{
 skip:!nativeSlidesDirectory||live&&!liveConfig,timeout:live?600000:90000,
},async t=>{
 const port=live?43684:43683,origin='http://localhost:'+port,f=await fileFixture(t,{origin,buildApp:false})
 const original=await readFile(new URL('../fixtures/slides/acceptance.pptx',import.meta.url))
 const {file}=await importFile(f,f.alice.token,original,'generate-deck.pptx')
 const keyring={activeKeyId:'slides-generate',keys:{'slides-generate':new Uint8Array(32).fill(44)}}
 const entry=live?JSON.parse(await readFile(liveConfig,'utf8')).entry:{
  id:'fixture',kind:'chat',providerId:'openai',label:'Fixture',model:'synthetic',baseUrl:'https://provider.example/v1',apiKey:'fixture-key',enabled:true,
 }
 assert.ok(entry?.enabled&&entry?.kind==='chat','An enabled chat model is required')
 await createGlobalConfigService({transactions:f.transactions,keyring}).saveGlobalConfig(f.adminSigned.token,0,{
  upserts:[entry],defaults:{chat:entry.id},
 })
 await f.preferences.update(f.alice.token,{language:'en',showAssistant:true,autoSave:false})
 const app=await buildLocalApp({
  db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,
  globalConfigKeyring:keyring,providerGateway:{mode:'shared'},codingHarnesses:false,nativeSlidesDirectory,
  localShellDirectory:process.env.DYOFFICE_TEST_LOCAL_SHELL_DIRECTORY??fileURLToPath(new URL('../../dist-local-shell',import.meta.url)),
  slidesHost:{openSession(input){return openIsolatedPptxSession(input,{timeoutMs:60000,unsafeTestOnly:true})}},
 })
 f.cleanup.unshift(()=>app.close())
 await app.listen({port,host:'127.0.0.1'})
 const browser=await launchTestBrowser();f.cleanup.unshift(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1360,height:900}})
 // Keep this test focused on generation, independently of the optional post-generation QC model pass.
 await page.addInitScript(()=>localStorage.setItem('ai-slides-qc','0'))
 const {csrfToken}=await (await page.request.get(origin+'/api/v1/auth/csrf')).json()
 assert.equal((await page.request.post(origin+'/api/v1/auth/login',{headers:{origin,'x-csrf-token':csrfToken},data:{username:'alice',password}})).status(),200)

 const contents=[
  ['Discovery Summary','The field team collected interviews and grouped recurring needs.'],
  ['Delivery Plan','The project lead will review findings and confirm the next milestone.'],
 ]
 const topic='Project handover',instruction='Generate a two-slide replacement deck about the project handover.'
 const style='Clean cream backgrounds with navy typography.',answer='Two editable slides are ready to save.'
 const revise='Redo only the second slide to give the reviewer a concrete action.'
 const revisedPage=['Review Checklist','Confirm the owner and sign off on the handover.']
 const revisedAnswer='Only the second slide was redone.'
 const revisedDeck=[contents[0],revisedPage]
 const template='Cream Handover',saveStyle='Save the current deck style as Cream Handover.'
 const styleSaved='The style is saved in your templates.'
 const reuseStyle='Append a follow-up slide using the saved Cream Handover template.'
 const followUp=['Follow-up','Send the signed checklist to the project lead.']
 const styleReused='The follow-up slide uses your saved style.'
 const pageSpec=lines=>({background:'#FFF8E7',elements:lines.map((text,index)=>({
  type:'text',x:80,y:80+index*140,w:840,h:105,paragraphs:[{runs:[{text,sizePt:index?17:42,color:'#172F50'}]}],
 }))})
 const phases=[]
 const network=live?undefined:mockProviderNetwork(t,()=>{try{
  const {messages,tools}=JSON.parse(network.wire.toString())
  const user=messages.findLast(message=>message.role==='user')?.content??''
  const result=messages.find(message=>message.role==='tool'&&message.tool_call_id==='generate-deck')
  const read=messages.find(message=>message.role==='tool'&&message.tool_call_id==='read-redo-page')
  const redo=messages.find(message=>message.role==='tool'&&message.tool_call_id==='redo-page')
  const outcome=id=>{
   const message=messages.find(message=>message.role==='tool'&&message.tool_call_id===id)
   if(!message)return
   const execution=JSON.parse(message.content)
   assert.ok(!execution.isError,execution.output)
   return execution.output
  }
  const request=user.split('\n\n',1)[0]
  const pageNumber=/Now design page ([12])\/2\./.exec(user)?.[1]
  const call=(id,name,input)=>({tool_calls:[{index:0,id,type:'function',function:{name,arguments:JSON.stringify(input)}}]})
  let delta
  if(user.includes('Now design page 1/1.')&&user.includes(followUp[0])){
   assert.ok(user.includes(style),'The saved style should reach the slide model')
   phases.push('template page')
   delta={content:JSON.stringify(pageSpec(followUp))}
  }else if(request===saveStyle){
   const savedStyle=outcome('save-style')
   if(savedStyle){
    assert.ok(savedStyle.includes(`Saved the style "${template}"`))
    delta={content:styleSaved}
   }else delta=call('save-style','save_style_template',{name:template})
  }else if(request===reuseStyle){
   const made=outcome('template-append'),available=outcome('list-style')
   if(made){
    assert.match(made,/produced 1\/1 pages/)
    delta={content:styleReused}
   }else if(available){
    assert.ok(available.includes(`- ${template} (topic: ${topic}`),available)
    delta=call('template-append','generate_deck',{topic:'Handover follow-up',style_template:template,insert_mode:'append',core_hook:'Confirm handover',pages:[{title:followUp[0],brief:followUp[1],type:'closing'}]})
   }else delta=call('list-style','list_style_templates',{})
  }else if(pageNumber==='2'&&user.includes(revisedPage[0])){
   assert.ok(user.includes(revisedPage[1]))
   phases.push('redesign page 2')
   delta={content:JSON.stringify(pageSpec(revisedPage))}
  }else if(request===revise){
   if(redo){
    const execution=JSON.parse(redo.content)
    assert.ok(!execution.isError,execution.output)
    assert.match(execution.output,/Redid page 2 in place/)
    phases.push('redo complete')
    delta={content:revisedAnswer}
   }else if(read){
    const execution=JSON.parse(read.content)
    assert.ok(!execution.isError,execution.output)
    assert.ok(execution.output.includes(contents[1][0]),execution.output)
    assert.ok(tools?.some(tool=>tool.function.name==='regenerate_slide'))
    phases.push('redo tool')
    delta=call('redo-page','regenerate_slide',{slideIndex:1,title:revisedPage[0],brief:revisedPage[1]})
   }else{
    phases.push('read page 2')
    delta=call('read-redo-page','read_slide',{slideIndex:1})
   }
  }else if(result){
   const execution=JSON.parse(result.content)
   assert.ok(!execution.isError,execution.output)
   assert.match(execution.output,/produced 2\/2 pages/)
   assert.doesNotMatch(execution.output,/degraded|failed after retry/)
   phases.push('complete')
   delta={content:answer}
  }else if(pageNumber){
   const [title,body]=contents[Number(pageNumber)-1]
   assert.ok(user.includes(title)&&user.includes(body))
   phases.push('page '+pageNumber)
   delta={content:JSON.stringify(pageSpec([title,body]))}
  }else if(user.startsWith('Topic and style preferences:')){
   assert.ok(user.includes(topic))
   phases.push('style')
   delta={content:style}
  }else if(user.includes('Plan 2 pages in total.')){
   assert.ok(user.includes(style))
   phases.push('outline')
   delta={content:JSON.stringify({core_hook:'Findings to action',pages:contents.map(([title,brief],index)=>({
    title,brief,type:index?'closing':'cover',layout:index?'closing_cta':'cover_typography_hero',image_queries:[],
   }))})}
  }else{
   assert.equal(request,instruction)
   assert.match(user,/<deck outline>[\s\S]*Acceptance title/)
   assert.ok(tools?.some(tool=>tool.function.name==='generate_deck'))
   const answers=outcome('handover-audience'),plan=outcome('handover-plan')
   if(plan){
    assert.match(plan,/Discovery Summary[\s\S]*Delivery Plan/)
    phases.push('office tool')
    delta=call('generate-deck','generate_deck',{topic,approx_pages:2,insert_mode:'replace'})
   }else if(answers){
    assert.match(answers,/Field team[\s\S]*Action checklist/)
    delta=call('handover-plan','plan_deck',{
     core_hook:'Findings to action',style,
     pages:contents.map(([title,brief],index)=>({title,brief,layout:index?'closing_cta':'cover_typography_hero'})),
    })
   }else{
    delta=call('handover-audience','ask_clarification',{questions:[
     {id:'audience',label:'Who is the handover for?',options:['Field team','Executives']},
     {id:'focus',label:'What should they take away?',options:['Action checklist','Project history']},
    ]})
   }
  }
  return Readable.from([Buffer.from('data: '+JSON.stringify({choices:[{delta,finish_reason:delta.tool_calls?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n')])
 }catch(error){t.diagnostic(error.stack);throw error}})

 const panel=page.locator('.ai-panel'),composer=panel.locator('textarea')
 const rail=page.getByRole('button',{name:'Expand AI assistant',exact:true})
 async function send(message){
  await expect(composer.or(rail)).toBeVisible()
  if(await rail.isVisible())await rail.click()
  await composer.fill(message)
  await panel.getByRole('button',{name:'Send',exact:true}).click()
 }
 const renderedText=()=>page.evaluate(async()=>{
  const slides=await window.slidesApi.getRenderSlides()
  return slides?.map(slide=>slide.nodes.flatMap(node=>{
   const text=node.text?.lines.map(line=>line.runs.map(run=>run.text).join('')).join(' ')
   return text?[text]:[]
  }))
 })
 const requireReady=()=>expect(page.locator('html')).toHaveAttribute('data-document-loading','ready',{timeout:25000})
 const head=async()=>(await f.files.openFile(f.alice.token,file.fileId)).file.revision
 const revisions=()=>f.transactions.withPrincipalTransaction({kind:'session',token:f.alice.token},async connection=>
  (await connection.query('SELECT id FROM file_revisions WHERE file_id=$1 ORDER BY created_at',[file.fileId])).rows.map(row=>row.id))

 const acceptedTools=new Map()
 page.on('request',request=>{
  if(request.method()!=='POST'||new URL(request.url()).pathname!=='/api/v1/ai/turns')return
  for(const message of request.postDataJSON()?.request?.messages??[]){
   for(const result of message.results??[])if(!result.isError)acceptedTools.set(result.name,result.output)
  }
 })
 if(live){
  const trace=[]
  t.after(()=>t.diagnostic('PPTX model turns: '+JSON.stringify(trace)))
  await page.exposeFunction('recordSlidesTestEvent',event=>trace.push(event))
  await page.addInitScript(()=>{
   const fetchOriginal=window.fetch.bind(window)
   window.fetch=async(input,init)=>{
    const path=new URL(input instanceof Request?input.url:input,location.href).pathname
    if(init?.method!=='POST')return fetchOriginal(input,init)
    const phase=path.endsWith('/slides/generate-page')?'create page':path.endsWith('/slides/generated-pages')?'land page':
     path.endsWith('/slides/history-batch-begin')?'begin history batch':path.endsWith('/slides/history-batch-end')?'end history batch':null
    if(phase){
     const response=await fetchOriginal(input,init)
     void window.recordSlidesTestEvent({phase,status:response.status})
     return response
    }
    if(path!=='/api/v1/ai/turns')return fetchOriginal(input,init)
    const {request}=JSON.parse(init.body)
    const prompt=request.messages.findLast(message=>message.role==='user')?.text??''
    const stage=request.tools.length?'assistant':prompt.startsWith('Topic and style preferences:')?'style':prompt.startsWith('Topic: ')?'outline':'page design'
    const turn=prompt.includes('Cobalt Review')?'redo':prompt.includes('Orchid Intake')?'initial':undefined
    const started=Date.now(),repair=prompt.includes('Your previous output was rejected:')
    const offered=request.tools.map(tool=>tool.name).filter(name=>[
     'ask_clarification','plan_deck','generate_deck','read_slide','regenerate_slide','save_style_template','list_style_templates',
    ].includes(name))
    void window.recordSlidesTestEvent({stage,turn,repair,started,offered})
    const response=await fetchOriginal(input,init)
    void response.clone().text().then(stream=>{
     const frames=[...new Set([...stream.matchAll(/^event: ([\w-]+)$/gm)].map(match=>match[1]))]
     const tools=[...stream.matchAll(/^event: tool_call\ndata: (.+)$/gm)].map(match=>JSON.parse(match[1]).name)
     const reply=stage==='assistant'&&!tools.length
      ? [...stream.matchAll(/^event: delta\ndata: (.+)$/gm)].map(match=>JSON.parse(match[1]).text??'').join('').slice(0,400)
      : undefined
     void window.recordSlidesTestEvent({stage,turn,started,status:response.status,frames,tools,reply,durationMs:Date.now()-started})
    },()=>window.recordSlidesTestEvent({stage,started,interrupted:true,durationMs:Date.now()-started}))
    return response
   }
  })
 }

 await page.goto(origin+'/native-pptx/?fileId='+file.fileId)
 await requireReady()
 assert.ok((await renderedText())[0].includes('Acceptance title'))
 if(live){
  const title=['Orchid Intake','Cobalt Release'],redoTitle='Cobalt Review'
  const audience='Field reviewers',artifact='Release checklist'
  const liveTemplate='Orchid Desk Template',appendTitle='Violet Handoff',appendTopic='Violet Delivery Follow-up'
  const templateColor='F5E6D3'
  const hasPage=(deck,index,text)=>deck?.[index]?.join(' ').includes(text)??false
  const assertSavedSlides=async(revision,expectedTitle)=>{
   const bytes=await f.files.readFile(f.alice.token,file.fileId,revision),slides=await savedSlides(bytes)
   assert.equal(slides.length,2)
   assert.ok(hasPage(slides.map(slide=>slide.text),0,title[0]),'Generated first page has the requested title')
   assert.ok(hasPage(slides.map(slide=>slide.text),1,expectedTitle),'Saved second page has the requested title')
   assert.ok(slides.every(slide=>slide.pictures===0),'The saved pages contain no images')
   assert.match(slides[0].text.join(' '),/Monday|周一|星期一/i)
   assert.match(slides[1].text.join(' '),expectedTitle===redoTitle?/checklist|清单/i:/Friday|周五|星期五/i)
   if(expectedTitle!==redoTitle){
    assert.ok(slides[0].text.join(' ').includes(audience),'The intake slide includes the chosen audience')
    assert.ok(slides[1].text.join(' ').includes(artifact),'The release slide includes the chosen deliverable')
   }
   return {bytes,slides}
  }
  const waitForPage=(index,text,timeout=25000)=>expect.poll(async()=>(await renderedText())?.[index]?.join(' ')??'',{timeout}).toContain(text)
  const save=async(base)=>{
   await page.keyboard.press('Control+s')
   await expect.poll(head,{timeout:15000}).not.toBe(base)
   const revision=await head()
   await expect.poll(()=>page.evaluate(()=>window.slidesApi.isDirty())).toBe(false)
   return revision
  }
  const settled=()=>expect(panel.locator('.ai-stop-btn')).toHaveCount(0,{timeout:30000})
  await send('替换现有演示文稿，只做两页，可编辑，不放图片。先用 ask_clarification 调出两道单选题。第一题问受众，选项是 Field reviewers 和 Project sponsors。第二题问交付物，选项是 Release checklist 和 Status memo。请保留选项英文原文。我回答后，先调用 plan_deck 写入两页规划，再调用 generate_deck 直接按规划替换，禁止再次问卷。第 1 页标题必须是 Orchid Intake，正文包含我选的受众英文原文与周一审核收件。第 2 页标题必须是 Cobalt Release，正文包含我选的交付物英文原文与周五审批发布。用简洁的内部评审风格，两页都必须使用纯色原生幻灯片背景 #'+templateColor+'，不添加遮挡背景的矩形。')
  await panel.getByRole('radio',{name:audience,exact:true}).click({timeout:120000})
  await panel.getByRole('radio',{name:artifact,exact:true}).click({timeout:15000})
  await waitForPage(0,title[0],270000)
  await waitForPage(1,title[1])
  await settled()
  const clarification=acceptedTools.get('ask_clarification')??''
  assert.ok(clarification.includes(audience)&&clarification.includes(artifact),clarification)
  const plan=acceptedTools.get('plan_deck')??''
  assert.match(plan,/Orchid Intake[\s\S]*Cobalt Release/)
  const generation=acceptedTools.get('generate_deck')??''
  assert.match(generation,/produced 2\/2 pages/,'The real model received a successful two-page generation result')
  assert.doesNotMatch(generation,/degraded to a plain-text fallback|failed after retry/)
  assert.deepEqual(await revisions(),[file.revision])
  const generated=await save(file.revision),first=await assertSavedSlides(generated,title[1])
  assert.equal(first.slides[0].background?.toUpperCase(),templateColor)
  const templates=createStyleTemplateService(f.transactions)
  await send('用 save_style_template 保存刚生成的幻灯片样式与版式，模板名称必须是 '+liveTemplate+'。')
  await expect.poll(()=>acceptedTools.get('save_style_template')??'',{timeout:60000}).toContain('Saved the style "'+liveTemplate+'"')
  await settled()
  const savedTemplate=await templates.load(f.alice.token,liveTemplate)
  assert.equal(savedTemplate.ok,true)
  assert.equal(savedTemplate.layout?.cover?.background?.toUpperCase(),'#'+templateColor)
  assert.ok(savedTemplate.styleSkill.trim())
  assert.deepEqual(await revisions(),[file.revision,generated])
  await page.reload()
  await requireReady()
  await waitForPage(1,title[1])

  acceptedTools.clear()
  const redoInstruction='用 regenerate_slide 只重做第 2 页。标题必须是 Cobalt Review，请在正文要求评审人核对发布清单。第 1 页保持原样。'
  await Promise.all([
   page.waitForRequest(request=>request.method()==='POST'&&new URL(request.url()).pathname==='/api/v1/ai/turns'&&
    request.postDataJSON()?.request?.messages.some(message=>message.role==='user'&&message.text?.includes(redoInstruction)),{timeout:30000}),
   send(redoInstruction),
  ])
  await waitForPage(1,redoTitle,270000)
  await settled()
  assert.ok(acceptedTools.has('regenerate_slide'),'The real model requested regeneration and received a successful result')
  assert.deepEqual(await revisions(),[file.revision,generated])
  const redone=await save(generated),second=await assertSavedSlides(redone,redoTitle)
  assert.equal(second.slides[0].source,first.slides[0].source)
  assert.deepEqual(await revisions(),[file.revision,generated,redone])
  assert.deepEqual(await f.files.readFile(f.alice.token,file.fileId,file.revision),original)
  assert.deepEqual(await f.files.readFile(f.alice.token,file.fileId,generated),first.bytes)
  await page.reload()
  await requireReady()
  await waitForPage(0,title[0])
  await waitForPage(1,redoTitle)
  acceptedTools.clear()
  const templatePrompts=[]
  page.on('request',request=>{
   if(request.method()!=='POST'||new URL(request.url()).pathname!=='/api/v1/ai/turns')return
   const prompt=request.postDataJSON()?.request?.messages.findLast(message=>message.role==='user')?.text
   if(prompt?.includes(appendTitle)&&prompt.includes('Now design page 1/1.'))templatePrompts.push(prompt)
  })
  await send('先调用 list_style_templates 找到 '+liveTemplate+'。接着用 generate_deck 的 style_template 复用它，insert_mode 为 append，传入一个 page，禁止问卷。主题 '+appendTopic+'，新增页标题 '+appendTitle+'，正文要求签署交接清单。不放图片，原来两页不改。')
  await waitForPage(2,appendTitle,120000)
  await settled()
  assert.ok(acceptedTools.get('list_style_templates')?.includes(liveTemplate))
  assert.match(acceptedTools.get('generate_deck')??'',/produced 1\/1 pages/)
  assert.ok(templatePrompts.some(prompt=>prompt.includes(savedTemplate.styleSkill)&&prompt.includes('Template chrome for cover pages')))
  assert.deepEqual(await revisions(),[file.revision,generated,redone])
  const appended=await save(redone)
  const appendedSlides=await savedSlides(await f.files.readFile(f.alice.token,file.fileId,appended))
  assert.equal(appendedSlides.length,3)
  assert.deepEqual(appendedSlides.slice(0,2).map(slide=>slide.source),second.slides.map(slide=>slide.source))
  assert.ok(hasPage(appendedSlides.map(slide=>slide.text),2,appendTitle))
  assert.match(appendedSlides[2].text.join(' '),/checklist|清单/i)
  assert.equal(appendedSlides[2].background?.toUpperCase(),templateColor)
  assert.deepEqual(await revisions(),[file.revision,generated,redone,appended])
  await page.reload()
  await requireReady()
  await waitForPage(2,appendTitle)
  return
 }
 const questionnaireResponses=[]
 const recordQuestionnaireResponse=response=>{
  if(response.request().method()==='POST'&&new URL(response.url()).pathname==='/api/v1/ai/turns'){
   questionnaireResponses.push(response.status())
  }
 }
 page.on('response',recordQuestionnaireResponse)
 try{
  await send(instruction)
  await panel.getByRole('radio',{name:'Field team',exact:true}).click()
  await panel.getByRole('radio',{name:'Action checklist',exact:true}).click()
 }catch(error){
  const panelErrors=await panel.locator('.ai-msg-error').allTextContents().catch(()=>[])
  t.diagnostic('PPTX questionnaire: '+JSON.stringify({responses:questionnaireResponses,providerWrites:network.writes,panelErrors}))
  throw error
 }finally{page.off('response',recordQuestionnaireResponse)}
 await expect(panel.getByText(answer,{exact:true})).toBeVisible({timeout:30000})
 await expect(page.locator('.thumb')).toHaveCount(2)
 await expect.poll(renderedText).toEqual(contents)
 assert.deepEqual(phases.slice(0,3),['office tool','style','outline'])
 assert.deepEqual(phases.slice(3,5).sort(),['page 1','page 2'])
 assert.deepEqual(phases.slice(5),['complete'])
 assert.ok(acceptedTools.has('generate_deck'))
 assert.ok(acceptedTools.has('ask_clarification'))
 assert.ok(acceptedTools.has('plan_deck'))
 assert.equal(await page.evaluate(()=>window.slidesApi.isDirty()),true)
 assert.equal(await head(),file.revision)
 assert.deepEqual(await revisions(),[file.revision])

 await page.keyboard.press('Control+s')
 await expect.poll(head,{timeout:15000}).not.toBe(file.revision)
 const saved=await head()
 await expect.poll(()=>page.evaluate(()=>window.slidesApi.isDirty())).toBe(false)
 assert.deepEqual(await revisions(),[file.revision,saved])
 const generated=await f.files.readFile(f.alice.token,file.fileId,saved)
 const generatedSlides=await savedSlides(generated)
 assert.deepEqual(generatedSlides.map(slide=>slide.text),contents)
 assert.deepEqual(await f.files.readFile(f.alice.token,file.fileId,file.revision),original)
 await send(saveStyle)
 await expect(panel.getByText(styleSaved,{exact:true})).toBeVisible({timeout:15000})
 assert.deepEqual(await revisions(),[file.revision,saved])

 await page.reload()
 await requireReady()
 await expect(page.locator('.thumb')).toHaveCount(2)
 assert.deepEqual(await renderedText(),contents)
 assert.equal(await head(),saved)
 assert.deepEqual(await revisions(),[file.revision,saved])

 await send(revise)
 await expect(panel.getByText(revisedAnswer,{exact:true})).toBeVisible({timeout:30000})
 assert.deepEqual(phases.slice(6),['read page 2','redo tool','redesign page 2','redo complete'])
 assert.ok(acceptedTools.has('regenerate_slide'))
 await expect.poll(renderedText).toEqual(revisedDeck)
 assert.equal(await head(),saved)
 await page.getByRole('button',{name:'Undo',exact:true}).click()
 await expect.poll(renderedText).toEqual(contents)
 await page.getByRole('button',{name:'Redo',exact:true}).click()
 await expect.poll(renderedText).toEqual(revisedDeck)
 assert.deepEqual(await revisions(),[file.revision,saved])

 await page.keyboard.press('Control+s')
 await expect.poll(head,{timeout:15000}).not.toBe(saved)
 const updated=await head()
 await expect.poll(()=>page.evaluate(()=>window.slidesApi.isDirty())).toBe(false)
 assert.deepEqual(await revisions(),[file.revision,saved,updated])
 const updatedSlides=await savedSlides(await f.files.readFile(f.alice.token,file.fileId,updated))
 assert.deepEqual(updatedSlides.map(slide=>slide.text),revisedDeck)
 assert.equal(updatedSlides[0].source,generatedSlides[0].source)
 assert.deepEqual(await f.files.readFile(f.alice.token,file.fileId,saved),generated)
 await page.reload()
 await requireReady()
 await expect.poll(renderedText).toEqual(revisedDeck)
 await send(reuseStyle)
 await expect(panel.getByText(styleReused,{exact:true})).toBeVisible({timeout:30000})
 await expect.poll(renderedText).toEqual([...revisedDeck,followUp])
 assert.deepEqual(phases.slice(10),['template page'])
 assert.deepEqual(await revisions(),[file.revision,saved,updated])
 await page.keyboard.press('Control+s')
 await expect.poll(head,{timeout:15000}).not.toBe(updated)
 const appended=await head()
 const appendedSlides=await savedSlides(await f.files.readFile(f.alice.token,file.fileId,appended))
 assert.deepEqual(appendedSlides.map(slide=>slide.text),[...revisedDeck,followUp])
 assert.deepEqual(appendedSlides.slice(0,2).map(slide=>slide.source),updatedSlides.map(slide=>slide.source))
 assert.equal(appendedSlides[2].background?.toUpperCase(),'FFF8E7')
 await page.reload()
 await requireReady()
 await expect.poll(renderedText).toEqual([...revisedDeck,followUp])
})
