import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { expect } from '@playwright/test'
import { launchTestBrowser } from '../helpers/browser.mjs'

test('DSH command card separates confirmed document saves from message synchronization',async t=>{
 const browser=await launchTestBrowser()
 t.after(()=>browser.close())
 const page=await browser.newPage({viewport:{width:800,height:620},deviceScaleFactor:1})
 const errors=[]
 page.on('pageerror',error=>errors.push(error.message))
 const fileId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',revision='b98d75ce-1111-4222-8333-cccccccccccc'
 const name='社区阅读日活动策划.docx'
 const preview={fileId,name,revision,text:'# 社区阅读日\n周六下午，社区图书馆将举办一场面向亲子的阅读活动。\n## 活动安排\n14:00　绘本共读\n15:00　小组交流'}
 const writing={id:'writing-1',topic:'拟一份社区阅读日活动策划，包含时间和流程。',review:{state:'ready',text:'活动流程已齐全，建议补充报名截止时间。'}}
 await page.route('https://dsh.test/**',route=>{
  const url=new URL(route.request().url())
  if(url.pathname.endsWith('dyoffice-preview'))return route.fulfill({json:url.searchParams.has('draftSync')?{ticket:'fixture'}:{origin:'https://office.test',dshEditorOrigin:'https://dsh.test',preview,writing}})
  return route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="zh"><meta charset="utf-8"><style>body{margin:16px;font:14px/1.5 system-ui,sans-serif;color:#243048;background:#fafbfe;--dsw-alias-label-secondary:#536274;--dsw-alias-bg-layer-1:white}</style><main></main></html>'})
 })
 await page.route('https://office.test/**',route=>route.fulfill({contentType:'text/html',body:`<script>
 window.addEventListener('message',e=>{
  if(!window.stalled&&e.data.type==='dsh-dyoffice:draft-request')e.source.postMessage({type:'dsh-dyoffice:draft',fileId:e.data.fileId,draft:null,writing:{id:'writing-1',state:'saved',revision:'${revision}'}},'https://dsh.test')
 })
 </script>`}))
 await page.goto('https://dsh.test/app/')
 const runtime=await build({stdin:{contents:"import * as React from 'react';import {createRoot} from 'react-dom/client';window.React=React;window.createRoot=createRoot",resolveDir:fileURLToPath(new URL('../../../../',import.meta.url))},bundle:true,write:false,define:{'process.env.NODE_ENV':'"production"'}})
 await page.addScriptTag({content:runtime.outputFiles[0].text})
 await page.evaluate(()=>{
  const slots={},listeners={}
  let copy
  const t=key=>copy.zh[key]
  window.__ModuleLoader__={load({factory}){
   factory(()=>window.React).apply({locale:{bind:()=>t,register:(_,value)=>{copy=value}},effect:f=>f(),on:(e,f)=>listeners[e]=f,
    sidebarRightTabs:{register(){}},uiConversation:{events:{register(){}},views:{register(){}}},
    slots:{inject:(_,f)=>f(),register:(spec,Component)=>slots[spec.name]=Component}})
  }}
  window.mount=(name,fileId)=>{
   const outcome={kind:'success',text:'已创建 '+name+'\nhttps://office.test/#/file/'+fileId}
   listeners['command/executed']('studio-session','dyoffice',outcome)
   const h=React.createElement
   createRoot(document.querySelector('main')).render(h(React.Fragment,null,
    h(slots['shell.overlay'],{t}),h(slots['conversation.chat.commandview'],{t,sessionId:'studio-session',node:{time:Date.now(),outcome}})))
  }
 })
 await page.addScriptTag({path:fileURLToPath(new URL('../../../../integrations/dsh-dyoffice/client.js',import.meta.url))})
 await page.evaluate(([name,id])=>mount(name,id),[name,fileId])
 const card=page.locator('.dsh-office-studio')
 await expect(card.getByText('消息同步中',{exact:true})).toBeVisible()
 await expect(card.getByText('活动流程已齐全，建议补充报名截止时间。')).toBeVisible()
 await expect(card.getByText('正文已保存，交给 DSH 审阅。')).toBeVisible()
 await expect(card.getByText('社区阅读日',{exact:true})).toBeVisible()
 await expect(card.getByRole('heading',{name:'通信记录',exact:true})).toBeVisible()
 const paper=card.locator('.dsh-office-canvas'),log=card.locator('.dsh-office-log')
 assert.ok((await log.boundingBox()).x>(await paper.boundingBox()).x)
 await mkdir('test-results/dsh-studio',{recursive:true})
 await card.screenshot({path:'test-results/dsh-studio/command.jpg',type:'jpeg',quality:64})
 await card.getByRole('button',{name:'编辑器',exact:true}).click()
 await expect(card.locator('.dsh-office-frame')).toBeVisible()
 await card.getByRole('button',{name:'正文',exact:true}).click()
 const editor=page.frames().find(frame=>frame.url().startsWith('https://office.test/'))
 await editor.evaluate(()=>window.stalled=true)
 await expect(card.getByText('同步中断',{exact:true})).toBeVisible()
 await expect(card.getByText('已保存版本',{exact:false})).toContainText(revision.slice(0,8))
 await page.setViewportSize({width:375,height:650})
 assert.ok((await log.boundingBox()).y>=(await paper.boundingBox()).y+(await paper.boundingBox()).height-1)
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth))
 await card.getByRole('button',{name:'结束 Office 对话'}).click()
 await expect(card.getByText('对话已结束',{exact:true})).toBeVisible()
 assert.deepEqual(errors,[])
})
