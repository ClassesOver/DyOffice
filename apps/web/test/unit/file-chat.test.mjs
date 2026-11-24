import test from 'node:test'
import assert from 'node:assert/strict'
import {startFileChat} from '../../../../packages/agent-core/src/file-chat.ts'
import {createFileChat} from '../../src/editors/file-chat.ts'

function transcript({gate,pageSize=32}={}){
  const rows=new Map()
  let revision=0
  function write(message){
    const key=message.turnId+':'+message.role
    const order=rows.get(key)?.message.order??revision+1
    rows.set(key,{revision:++revision,message:{...message,order}})
  }
  function add(turnId,answer,state='done'){
    write({turnId,role:'user',text:turnId,state:'done',seq:0})
    write({turnId,role:'assistant',text:answer,state,seq:1})
  }
  async function request(_path,_method,{after,updates}){
    for(const message of updates)write(message)
    const changes=[...rows.values()].filter(row=>row.revision>after).sort((a,b)=>a.revision-b.revision)
    const page=changes.slice(0,pageSize)
    await gate
    return {cursor:page.at(-1)?.revision??after,hasMore:changes.length>page.length,messages:page.map(row=>row.message)}
  }
  return {add,request}
}
const texts=messages=>messages.map(message=>message.text)

test('reset hides earlier turns from the open page and model while preserving file history',async t=>{
  const server=transcript(),transport={}
  server.add('archived','partial','streaming')
  const chat=createFileChat('file',transport,server.request)
  t.after(()=>chat.dispose())
  const old=await chat.resume('archived',{})
  assert.deepEqual(texts(chat.read()),['archived','partial'])
  const snapshots=[]
  chat.subscribe(()=>snapshots.push(texts(chat.read())))
  chat.reset()
  assert.deepEqual(snapshots.at(-1),[])
  old.finish('late archived reply',false)
  server.add('shared after reset','new shared reply')
  const fresh=startFileChat(transport,{text:'new local question'},{})
  assert.deepEqual(texts(await fresh.history()),['shared after reset','new shared reply'])
  assert.deepEqual(texts(chat.read()),['shared after reset','new shared reply'])
  fresh.finish('new local reply',false)
  const next=startFileChat(transport,{text:'follow up'},{})
  assert.deepEqual(texts(await next.history()),['shared after reset','new shared reply','new local question','new local reply'])
  chat.reset()
  assert.deepEqual(chat.read(),[])
  assert.deepEqual(await startFileChat(transport,{text:'second reset'},{}).history(),[])
  chat.dispose()
  const reopened=createFileChat('file',{},server.request)
  t.after(()=>reopened.dispose())
  await reopened.resume('archived',{})
  assert.ok(texts(reopened.read()).includes('late archived reply'))
})

test('reset during paged restoration keeps only turns started locally after reset',async t=>{
  const loading=Promise.withResolvers(),server=transcript({gate:loading.promise,pageSize:1}),transport={}
  server.add('before open','late history')
  server.add('pending before open','','streaming')
  const chat=createFileChat('file',transport,server.request)
  t.after(()=>chat.dispose())
  const resuming=chat.resume('pending before open',{})
  const previous=startFileChat(transport,{text:'before reset'},{}),oldHistory=previous.history()
  chat.reset()
  previous.finish('old async reply',false)
  const next=startFileChat(transport,{text:'after reset'},{})
  next.finish('keep this reply',false)
  const following=startFileChat(transport,{text:'after reset follow up'},{}),history=following.history()
  loading.resolve()
  assert.deepEqual(await oldHistory,[])
  assert.equal(await resuming,undefined)
  assert.deepEqual(chat.read(),[])
  assert.deepEqual(texts(await history),['after reset','keep this reply'])
})

test('a previously started poll cannot restore a pre-reset turn that was not rendered yet',async t=>{
  const server=transcript(),transport={}
  let gate
  const chat=createFileChat('file',transport,async(...args)=>{
    const snapshot=await server.request(...args)
    await gate
    return snapshot
  })
  t.after(()=>chat.dispose())
  await chat.resume('absent',{})
  const pending=Promise.withResolvers()
  gate=pending.promise
  server.add('arrived before reset','old reply')
  const poll=chat.resume('absent',{})
  chat.reset()
  const next=startFileChat(transport,{text:'fresh start'},{}),history=next.history()
  pending.resolve()
  await poll
  assert.deepEqual(chat.read(),[])
  assert.deepEqual(await history,[])
})

test('reset fences remote turns written between polls',async t=>{
  const server=transcript(),transport={}
  const chat=createFileChat('file',transport,server.request)
  t.after(()=>chat.dispose())
  await chat.resume('absent',{})
  server.add('between polls','completed before reset')
  chat.reset()
  server.add('after boundary','keep this')
  const fresh=startFileChat(transport,{text:'fresh start'},{})
  assert.deepEqual(texts(await fresh.history()),['after boundary','keep this'])
})
