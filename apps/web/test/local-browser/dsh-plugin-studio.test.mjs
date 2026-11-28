import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { expect } from '@playwright/test'
import { launchTestBrowser } from '../helpers/browser.mjs'

async function mountCard(t, embedOrigins, writingState='saved', previewText) {
 const browser=await launchTestBrowser()
 t.after(()=>browser.close())
 const context=await browser.newContext({viewport:{width:800,height:620},deviceScaleFactor:1})
 const page=await context.newPage()
 const errors=[]
 page.on('pageerror',error=>errors.push(error.message))
 const dshOrigin='https://localhost:4681',officeOrigin='https://localhost:4682'
 const fileId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',revision='b98d75ce-1111-4222-8333-cccccccccccc'
 const name='社区阅读日活动策划.docx'
 const preview={fileId,name,revision,text:previewText??'# 社区阅读日\n周六下午，社区图书馆将举办一场面向亲子的阅读活动。\n## 活动安排\n14:00　绘本共读\n15:00　小组交流'}
 const writing={id:'writing-1',topic:'拟一份社区阅读日活动策划，包含时间和流程。',review:{state:'ready',text:'活动流程已齐全，建议补充报名截止时间。'}}
 await context.route(dshOrigin+'/**',route=>{
  const url=new URL(route.request().url())
  if(url.pathname.endsWith('dyoffice-preview'))return route.fulfill({json:url.searchParams.has('draftSync')?{ticket:'fixture'}:{origin:officeOrigin,...embedOrigins,preview,writing}})
  return route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="zh"><meta charset="utf-8"><style>body{margin:16px;font:14px/1.5 system-ui,sans-serif;color:#243048;background:#fafbfe;--dsw-alias-label-secondary:#536274;--dsw-alias-bg-layer-1:white}</style><main></main></html>'})
 })
 await page.context().route(officeOrigin+'/**',route=>route.fulfill({contentType:'text/html',body:`<!doctype html>
 <h1>DyOffice document</h1><label>Document text<input aria-label="Document text"></label>
 <script>
 window.addEventListener('message',e=>{
  if(${writingState!==null}&&!window.stalled&&e.data.type==='dsh-dyoffice:draft-request')e.source.postMessage({type:'dsh-dyoffice:draft',fileId:e.data.fileId,draft:null,writing:{id:'writing-1',state:'${writingState}',revision:'${revision}'}},'${dshOrigin}')
 })
 </script>`}))
 const runtime=await build({stdin:{contents:"import * as React from 'react';import {createRoot} from 'react-dom/client';window.React=React;window.createRoot=createRoot",resolveDir:fileURLToPath(new URL('../../../../',import.meta.url))},bundle:true,write:false,define:{'process.env.NODE_ENV':'"production"'}})
 async function render(page,fromHistory=false){
  await page.goto(dshOrigin+'/app/')
  await page.addScriptTag({content:runtime.outputFiles[0].text})
  await page.evaluate(officeOrigin=>{
   const slots={},listeners={}
   let copy
   const t=key=>copy.zh[key]
   window.__ModuleLoader__={load({factory}){
    factory(()=>window.React).apply({locale:{bind:()=>t,register:(_,value)=>{copy=value}},effect:f=>f(),on:(e,f)=>listeners[e]=f,
     sidebarRightTabs:{register(){}},uiConversation:{events:{register(){}},views:{register(){}}},
     slots:{inject:(_,f)=>f(),register:(spec,Component)=>slots[spec.name]=Component}})
   }}
   window.routeMessage=()=>listeners['conversation/route-message']({sessionId:'studio-session',text:'你好',attachmentCount:0})
   window.mount=(name,fileId,fromHistory)=>{
    const outcome={kind:'success',text:'已创建 '+name+'\n'+officeOrigin+'/#/file/'+fileId}
    if(!fromHistory)listeners['command/executed']('studio-session','dyoffice',outcome)
    const h=React.createElement
    createRoot(document.querySelector('main')).render(h(React.Fragment,null,
     h(slots['shell.overlay'],{t}),
     h('div',{id:'chat-viewport',style:{overflow:'auto'}},
      h(slots['conversation.chat.commandview'],{t,sessionId:'studio-session',node:{time:Date.now(),outcome}}))))
   }
  },officeOrigin)
  await page.addScriptTag({path:fileURLToPath(new URL('../../../../integrations/dsh-dyoffice/client.js',import.meta.url))})
  await page.evaluate(([name,id,history])=>mount(name,id,history),[name,fileId,fromHistory])
 }
 await render(page)
 const card=page.locator('.dsh-office-studio')
 return {page,card,name,fileId,revision,errors,officeOrigin,reloadHistory:()=>render(page,true),openHistory:async()=>{
  const tab=await context.newPage()
  await render(tab,true)
  return tab
 }}
}

for(const embedOrigins of [{dshEditorOrigin:'https://localhost:4681'},{dshEditorOrigins:['http://localhost:3080','https://localhost:4681']}])test(`DSH command card runs an interactive Office page with ${Object.keys(embedOrigins)[0]}`,async t=>{
 const {page,card,name,fileId,revision,errors,officeOrigin}=await mountCard(t,embedOrigins)
 await expect(card.getByText('消息同步中',{exact:true})).toBeVisible()
 await expect(card.getByText('活动流程已齐全，建议补充报名截止时间。')).toBeVisible()
 await expect(card.getByText('正文已保存，交给 DSH 审阅。')).toBeVisible()
 const frame=page.locator('iframe[title="'+name+'"]')
 await expect(card.locator('.dsh-office-frame')).toBeVisible()
 await expect(frame).toBeVisible()
 await expect(frame).toHaveAttribute('src',officeOrigin+'/?dshEmbed=1#/file/'+fileId)
 await expect(frame.contentFrame().getByRole('heading',{name:'DyOffice document'})).toBeVisible()
 const input=frame.contentFrame().getByRole('textbox',{name:'Document text'})
 const inputBounds=await input.boundingBox()
 await page.mouse.click(inputBounds.x+10,inputBounds.y+10)
 await page.keyboard.type('Edit inside DSH')
 await expect(input).toHaveValue('Edit inside DSH',{timeout:2000})
 const paper=card.locator('.dsh-office-canvas'),log=card.getByRole('region',{name:'DSH 与 DyOffice 的消息'})
 await expect(log.getByRole('heading')).toHaveCount(0)
 assert.ok((await log.boundingBox()).y>=(await paper.boundingBox()).y+(await paper.boundingBox()).height-1)
 const popupPromise=page.waitForEvent('popup')
 await card.getByRole('button',{name:'在新窗口打开 DyOffice',exact:false}).click()
 const popup=await popupPromise
 await popup.waitForLoadState()
 assert.equal(popup.url(),officeOrigin+'/#/file/'+fileId)
 await popup.close()
 await mkdir('test-results/dsh-studio',{recursive:true})
 await card.screenshot({path:'test-results/dsh-studio/command.jpg',type:'jpeg',quality:64})
 await card.getByRole('button',{name:'正文',exact:true}).click()
 await expect(card.getByText('社区阅读日',{exact:true})).toBeVisible()
 await expect(frame).toBeHidden()
 await card.getByRole('button',{name:'Office 网页',exact:true}).click()
 await expect(frame).toBeVisible()
 const editor=page.frames().find(frame=>frame.url().startsWith(officeOrigin+'/'))
 await editor.evaluate(()=>window.stalled=true)
 await expect(card.getByText('同步中断',{exact:true})).toBeVisible()
 await expect(card.getByText('已保存版本',{exact:false})).toContainText(revision.slice(0,8))
 await page.setViewportSize({width:375,height:650})
 assert.ok((await log.boundingBox()).y>=(await paper.boundingBox()).y+(await paper.boundingBox()).height-1)
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth))
 await card.getByRole('button',{name:'结束 Office 对话'}).click()
 await expect(card.getByText('对话已结束',{exact:true})).toBeVisible()
 await expect(card.getByText('社区阅读日',{exact:true})).toBeVisible()
 await expect(frame).toHaveCount(0)
 assert.deepEqual(errors,[])
})

test('a pending task without embedding leaves messages with DSH and can be ended',async t=>{
 const {page,card}=await mountCard(t,{dshEditorOrigins:[]})
 await expect(card.getByText(/拟一份社区阅读日活动策划/)).toBeVisible()
 assert.equal(await page.evaluate(()=>window.routeMessage()),undefined)
 await expect(card.getByText('请在新窗口打开 DyOffice 以开始撰写。')).toBeVisible()
 await card.getByRole('button',{name:'结束 Office 对话'}).click()
 await expect(card.getByText('对话已结束',{exact:true})).toBeVisible()
 await expect(card.getByText('请在新窗口打开 DyOffice 以开始撰写。')).toHaveCount(0)
 assert.equal(await page.evaluate(()=>window.routeMessage()),undefined)
})

test('opening the external writer hands follow-up messages to Office after saving',async t=>{
 const {page,card}=await mountCard(t,{dshEditorOrigins:[]})
 await expect(card.getByText('请在新窗口打开 DyOffice 以开始撰写。')).toBeVisible()
 const opened=page.waitForEvent('popup')
 await card.getByRole('button',{name:'在新窗口打开 DyOffice',exact:false}).click()
 const popup=await opened
 await expect(card.getByText('正文已保存，交给 DSH 审阅。')).toBeVisible()
 assert.deepEqual(await page.evaluate(()=>window.routeMessage()),{kind:'success'})
 await popup.close()
})

test('the interactive frame follows a message expanding above the card',async t=>{
 const {page,card,name}=await mountCard(t,{dshEditorOrigin:'https://localhost:4681'})
 await page.setViewportSize({width:900,height:1100})
 const frame=page.locator('iframe[title="'+name+'"]'), anchor=card.locator('.dsh-office-frame')
 await expect(card.getByText('消息同步中',{exact:true})).toBeVisible()
 const initial=await anchor.boundingBox()
 await page.evaluate(()=>{const message=document.createElement('div');message.style.height='64px';document.body.prepend(message)})
 assert.equal((await anchor.boundingBox()).y,initial.y+64)
 await expect.poll(async()=>Math.abs((await frame.boundingBox()).y-(await anchor.boundingBox()).y)).toBeLessThan(1)
})

for(const state of ['planning','writing','saved'])test(`closing the Office popup during ${state} releases chat and allows ending the conversation`,async t=>{
 const {page,card}=await mountCard(t,{dshEditorOrigins:[]},state)
 const opened=page.waitForEvent('popup')
 await card.getByRole('button',{name:/在新窗口打开/}).click()
 const popup=await opened
 await expect(card.getByText('消息同步中',{exact:true})).toBeVisible()
 await popup.close()
 await expect(card.getByText('同步中断',{exact:true})).toBeVisible()
 assert.equal(await page.evaluate(()=>window.routeMessage()),undefined)
 await expect(card.getByText('消息接收方 · DyOffice')).toHaveCount(0)
 await card.getByRole('button',{name:'结束 Office 对话'}).click()
 await expect(card.getByText('对话已结束',{exact:true})).toBeVisible()
 await expect(card.getByText(/可结束 Office 对话或重新发起/)).toHaveCount(0)
 assert.equal(await page.evaluate(()=>window.routeMessage()),undefined)
})

test('a resized chat viewport clips the interactive frame and restores it when expanded',async t=>{
 const {page,card}=await mountCard(t,{dshEditorOrigin:'https://localhost:4681'})
 await page.setViewportSize({width:900,height:1100})
 await expect(card.getByText('消息同步中',{exact:true})).toBeVisible()
 const viewport=page.locator('#chat-viewport')
 const bounds=await card.locator('.dsh-office-frame').boundingBox()
 const viewportTop=(await viewport.boundingBox()).y
 const x=bounds.x+20,y=bounds.y+bounds.height*0.75
 const hit=()=>page.evaluate(([x,y])=>document.elementFromPoint(x,y)?.tagName,[x,y])
 await expect.poll(hit).toBe('IFRAME')
 await viewport.evaluate((el,height)=>{
  el.style.height=height+'px'
  el.style.borderBottom='8px solid black'
 },bounds.y-viewportTop+bounds.height/2)
 await expect.poll(hit).not.toBe('IFRAME')
 const clipped=await viewport.boundingBox()
 const borderY=clipped.y+clipped.height-4
 await expect.poll(()=>page.evaluate(([x,y])=>document.elementFromPoint(x,y)?.id,[x,borderY])).toBe('chat-viewport')
 await viewport.evaluate(el=>el.style.removeProperty('height'))
 await expect.poll(hit).toBe('IFRAME')
})

for(const state of ['writing','saved'])test(`a replacement Office window must confirm its own task after ${state}`,async t=>{
 const {page,card,fileId}=await mountCard(t,{dshEditorOrigins:[]},state)
 const open=async()=>{
  const opened=page.waitForEvent('popup')
  await card.getByRole('button',{name:/在新窗口打开/}).click()
  return opened
 }
 const first=await open()
 await expect(card.getByText('消息同步中',{exact:true})).toBeVisible()
 await first.close()
 await expect(card.getByText('同步中断',{exact:true})).toBeVisible()
 await page.context().addInitScript(()=>{window.stalled=true})
 const replacement=await open()
 await replacement.waitForLoadState()
 assert.equal(await page.evaluate(()=>window.routeMessage()),undefined)
 await expect(card.getByRole('button',{name:'结束 Office 对话'})).toBeVisible()
 await replacement.evaluate(id=>window.opener.postMessage({type:'dsh-dyoffice:draft',fileId:id,draft:null},'https://localhost:4681'),fileId)
 await expect(card.getByText('消息同步中',{exact:true})).toBeVisible()
 assert.equal(await page.evaluate(()=>window.routeMessage()),undefined)
 await replacement.evaluate(()=>{window.stalled=false})
 const stage=state==='saved'?'正文已保存，交给 DSH 审阅。':'DyOffice 正在撰写…'
 await expect(card.getByText(stage,{exact:true})).toBeVisible()
 const reply=await page.evaluate(()=>window.routeMessage())
 assert.equal(reply.kind,state==='saved'?'success':'error')
})

test('changing overflow without resizing updates the interactive clip in both directions',async t=>{
 const {page,card}=await mountCard(t,{dshEditorOrigin:'https://localhost:4681'})
 await page.setViewportSize({width:900,height:1100})
 await expect(card.getByText('消息同步中',{exact:true})).toBeVisible()
 const viewport=page.locator('#chat-viewport')
 const anchor=card.locator('.dsh-office-frame')
 await expect(anchor).toBeVisible()
 // Model earlier chat content ahead of the card. Clip through the frame,
 // not a fixed offset that may land on the card header when layout changes.
 await viewport.evaluate(el=>{
  const earlier=document.createElement('div')
  earlier.style.height='460px'
  el.prepend(earlier)
 })
 const viewportTop=(await viewport.boundingBox()).y
 const frameBounds=await anchor.boundingBox()
 const frameBottom=Math.min(frameBounds.y+frameBounds.height,page.viewportSize().height)
 assert.ok(frameBottom-frameBounds.y>40)
 const clipY=frameBounds.y+(frameBottom-frameBounds.y)/2
 await viewport.evaluate((el,height)=>Object.assign(el.style,{height:height+'px',overflow:'visible'}),clipY-viewportTop)
 const viewportBounds=await viewport.boundingBox()
 const point={x:frameBounds.x+50,y:(clipY+frameBottom)/2}
 const inside={...point,y:(frameBounds.y+clipY)/2}
 const hit=()=>page.evaluate(({x,y})=>document.elementFromPoint(x,y)?.tagName,point)
 await expect.poll(hit).toBe('IFRAME')
 await viewport.evaluate(el=>el.style.overflow='hidden')
 await expect.poll(hit).not.toBe('IFRAME')
 assert.deepEqual(await viewport.boundingBox(),viewportBounds)
 await expect.poll(()=>page.evaluate(({x,y})=>document.elementFromPoint(x,y)?.tagName,inside)).toBe('IFRAME')
 await viewport.evaluate(el=>el.style.overflow='visible')
 await expect.poll(hit).toBe('IFRAME')
 assert.deepEqual(await viewport.boundingBox(),viewportBounds)
})

for(const state of ['writing','saved'])test(`a stale ${state} popup releases chat until it confirms the task again`,async t=>{
 const {page,card,fileId}=await mountCard(t,{dshEditorOrigins:[]},state)
 const opened=page.waitForEvent('popup')
 await card.getByRole('button',{name:/在新窗口打开/}).click()
 const popup=await opened
 await expect(card.getByText('消息同步中',{exact:true})).toBeVisible()
 if(state==='saved'){
  await popup.evaluate(()=>window.addEventListener('message',e=>{if(e.data.followup?.question)window.received=true}))
  assert.deepEqual(await page.evaluate(()=>window.routeMessage()),{kind:'success'})
  await expect.poll(()=>popup.evaluate(()=>window.received)).toBe(true)
 }
 await popup.addInitScript(()=>{window.stalled=true})
 await popup.reload()
 await expect(card.getByText('同步中断',{exact:true})).toBeVisible()
 assert.equal(await page.evaluate(()=>window.routeMessage()),undefined)
 await expect(card.getByText('DyOffice 未能回答，请重试。',{exact:true})).toHaveCount(0)
 await expect(card.getByText('消息接收方 · DyOffice')).toHaveCount(0)
 await expect(card.getByRole('button',{name:'结束 Office 对话'})).toBeVisible()
 await popup.evaluate(id=>window.opener.postMessage({type:'dsh-dyoffice:draft',fileId:id,draft:null},'https://localhost:4681'),fileId)
 await expect(card.getByText('消息同步中',{exact:true})).toBeVisible()
 assert.equal(await page.evaluate(()=>window.routeMessage()),undefined)
 await popup.evaluate(()=>{window.stalled=false})
 const stage=state==='saved'?'正文已保存，交给 DSH 审阅。':'DyOffice 正在撰写…'
 await expect(card.getByText(stage,{exact:true})).toBeVisible()
 if(state==='saved')await expect(card.getByText('无法确认这次追问的结果，请在 DyOffice 查看记录。',{exact:true})).toBeVisible()
 const reply=await page.evaluate(()=>window.routeMessage())
 assert.equal(reply.kind,state==='saved'?'success':'error')
})

test('refreshing history keeps an explicitly ended blank writing task closed',async t=>{
 const {page,card,reloadHistory}=await mountCard(t,{dshEditorOrigin:'https://localhost:4681'},null,'')
 const end=card.getByRole('button',{name:'结束 Office 对话'})
 await expect(page.locator('iframe')).toBeVisible()
 await end.click()
 await expect(card.getByText('对话已结束',{exact:true})).toBeVisible()
 let runnerRequests=0
 page.on('request',request=>{
  const params=new URL(request.url()).searchParams
  if(params.has('file')&&!params.has('inlinePreview'))runnerRequests++
 })
 await reloadHistory()
 await expect(card.getByText(/拟一份社区阅读日活动策划/)).toBeVisible()
 await expect(card.getByText('对话已结束',{exact:true})).toBeVisible()
 await expect(end).toHaveCount(0)
 await expect(page.locator('iframe')).toHaveCount(0)
 assert.equal(runnerRequests,0)
 assert.equal(await page.evaluate(()=>window.routeMessage()),undefined)
})

for(const loseFirstReceipt of [false,true])test(`recovers the follow-up by ID when sync drops ${loseFirstReceipt?'before':'after'} its first receipt`,async t=>{
 const {page,card}=await mountCard(t,{dshEditorOrigins:[]})
 const opened=page.waitForEvent('popup')
 await card.getByRole('button',{name:/在新窗口打开/}).click()
 const popup=await opened
 await expect(card.getByText('消息接收方 · DyOffice')).toBeVisible()
 await popup.evaluate(loseFirstReceipt=>{
  window.stalled=true
  window.submissions=0
  window.addEventListener('message',e=>{
   if(e.data.type!=='dsh-dyoffice:draft-request'||window.offline)return
   const ask=e.data.followup
   if(ask?.question){
    if(window.finished)window.replayed=true
    if(!window.turn){
     window.submissions++
     window.turn={id:ask.id,state:'answering',answer:'Partial reply'}
     if(loseFirstReceipt){window.offline=true;return}
    }
   }
   e.source.postMessage({type:'dsh-dyoffice:draft',fileId:e.data.fileId,draft:null,
    writing:{id:'writing-1',state:'saved'},followup:ask?.id===window.turn?.id?window.turn:undefined},e.origin)
  })
 },loseFirstReceipt)
 assert.deepEqual(await page.evaluate(()=>window.routeMessage()),{kind:'success'})
 await expect.poll(()=>popup.evaluate(()=>window.submissions)).toBe(1)
 if(!loseFirstReceipt)await expect(card.getByText('Partial reply',{exact:true})).toBeVisible()
 await popup.evaluate(()=>{window.offline=true})
 await expect(card.getByText('同步中断',{exact:true})).toBeVisible()
 assert.equal(await page.evaluate(()=>window.routeMessage()),undefined)
 await popup.evaluate(()=>{Object.assign(window.turn,{state:'ready',answer:'Final reply'});window.finished=true;window.offline=false})
 await expect(card.getByText('Final reply',{exact:true})).toBeVisible()
 assert.equal(await popup.evaluate(()=>window.replayed),undefined)
 assert.equal(await popup.evaluate(()=>window.submissions),1)
 assert.deepEqual(await page.evaluate(()=>window.routeMessage()),{kind:'success'})
})

test('a terminal writing failure remains visible through missed and draft-only receipts',async t=>{
 const {page,card,fileId}=await mountCard(t,{dshEditorOrigins:[]},'noModel')
 const opened=page.waitForEvent('popup')
 await card.getByRole('button',{name:/在新窗口打开/}).click()
 const popup=await opened
 const reason=card.getByText('请在 DyOffice 配置撰写模型。',{exact:true})
 await expect(reason).toBeVisible()
 await popup.evaluate(()=>{window.stalled=true})
 await expect(card.getByText('同步中断',{exact:true})).toBeVisible()
 await expect(reason).toBeVisible()
 await popup.evaluate(id=>window.opener.postMessage({type:'dsh-dyoffice:draft',fileId:id,draft:null},'https://localhost:4681'),fileId)
 await expect(card.getByText('消息同步中',{exact:true})).toBeVisible()
 await expect(reason).toBeVisible()
 assert.equal(await page.evaluate(()=>window.routeMessage()),undefined)
 await popup.close()
 await expect(card.getByText('同步中断',{exact:true})).toBeVisible()
 await expect(reason).toBeVisible()
})

test('ending an empty writing task stops other open history cards and survives a new tab',async t=>{
 const {page,card,openHistory}=await mountCard(t,{dshEditorOrigin:'https://localhost:4681'},null,'')
 const other=await openHistory()
 await expect(other.locator('iframe')).toBeVisible()
 await card.getByRole('button',{name:'结束 Office 对话'}).click()
 await expect(other.getByText('对话已结束',{exact:true})).toBeVisible()
 await expect(other.locator('iframe')).toHaveCount(0)
 await other.close()
 await page.close()
 const reopened=await openHistory()
 await expect(reopened.getByText('对话已结束',{exact:true})).toBeVisible()
 await expect(reopened.locator('iframe')).toHaveCount(0)
})

test('a question is delivered when the writer misses the first request during authorization renewal',async t=>{
 const {page,card}=await mountCard(t,{dshEditorOrigins:[]})
 const opened=page.waitForEvent('popup')
 await card.getByRole('button',{name:/在新窗口打开/}).click()
 const popup=await opened
 await expect(card.getByText('消息接收方 · DyOffice')).toBeVisible()
 await popup.evaluate(()=>{
  window.stalled=true
  window.addEventListener('message',e=>{
   if(e.data.type!=='dsh-dyoffice:draft-request')return
   const ask=e.data.followup
   if(ask&&!window.dropped){window.dropped=true;return}
   const followup=ask&&{id:ask.id,state:ask.question?'ready':'unknown',answer:ask.question?'Delivered':''}
   e.source.postMessage({type:'dsh-dyoffice:draft',fileId:e.data.fileId,draft:null,
    writing:{id:'writing-1',state:'saved'},followupScope:'writer-session',followup},e.origin)
   window.advertised=true
  })
 })
 await expect.poll(()=>popup.evaluate(()=>window.advertised)).toBe(true)
 assert.deepEqual(await page.evaluate(()=>window.routeMessage()),{kind:'success'})
 await expect(card.getByText('Delivered',{exact:true})).toBeVisible()
})
