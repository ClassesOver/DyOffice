import {act, createElement as h, useState} from 'react'
import {createRoot} from 'react-dom/client'
import {expect, test} from 'vitest'
import {SourceEgressSettings} from '../../src/shell/SourceEgressSettings'
import type {SourceEgressTarget} from '../../../../packages/web-contracts/src/settings'

;(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true

test('new database targets default to ordinary transport and support explicit TLS',async()=>{
 const host=document.createElement('div')
 document.body.append(host)
 const root=createRoot(host)
 let draft:SourceEgressTarget[]=[]
 function Settings(){
  const [targets,setTargets]=useState<SourceEgressTarget[]>([])
  return h(SourceEgressSettings,{targets,disabled:false,onChange(value){draft=value;setTargets(value)}})
 }
 try{
  await act(async()=>root.render(h(Settings)))
  const add=[...host.querySelectorAll('button')].find(button=>button.textContent==='添加目标')!
  await act(async()=>add.click())
  expect(draft[0].allowInsecure).toBe(true)
  const tls=host.querySelector<HTMLInputElement>('input[type=checkbox]')!
  expect(tls.checked).toBe(false)
  await act(async()=>tls.click())
  expect(draft[0].allowInsecure).toBe(false)
  const kind=host.querySelector<HTMLSelectElement>('fieldset select')!
  await act(async()=>{kind.value='mysql';kind.dispatchEvent(new Event('change',{bubbles:true}))})
  expect(tls.checked).toBe(false)
  expect(draft[0].allowInsecure).toBe(true)
  await act(async()=>{kind.value='postgres';kind.dispatchEvent(new Event('change',{bubbles:true}))})
  expect(tls.checked).toBe(false)
  await act(async()=>{kind.value='starrocks';kind.dispatchEvent(new Event('change',{bubbles:true}))})
  expect(tls.checked).toBe(false)
 }finally{await act(async()=>root.unmount());host.remove()}
})
