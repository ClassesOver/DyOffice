import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {createContext,runInContext} from 'node:vm'
test('legacy navigation guard protects dirty, saving and unknown states and allows clean documents',async()=>{
 const script=await readFile(new URL('../public/app.js',import.meta.url),'utf8');const events={};let confirmations=0
 const node=()=>({append(){},replaceChildren(){}})
 const ctx=createContext({document:{querySelector:node,createElement:node},location:{pathname:'/legacy.html'},sessionStorage:{getItem:()=>null},addEventListener:(name,fn)=>events[name]=fn,confirm:()=>{confirmations++;return false}})
 runInContext(script,ctx)
 for(const state of [{dirty:true,status:'idle'},{dirty:false,status:'saving'},{dirty:false,status:'unknown'}]){
  runInContext(`docxSession={getState:()=>(${JSON.stringify(state)})}`,ctx)
  assert.equal(runInContext('canLeaveEditor()',ctx),false)
  let prevented=false;const event={preventDefault(){prevented=true}};events.beforeunload(event);assert.equal(prevented,true);assert.equal(event.returnValue,'')
 }
 assert.equal(confirmations,3)
 runInContext("docxSession={getState:()=>({dirty:false,status:'idle'})}",ctx)
 assert.equal(runInContext('canLeaveEditor()',ctx),true);assert.equal(confirmations,3)
})
