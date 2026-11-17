import {test,expect} from 'vitest'
import {loginDomSnapshot,reportLoginDom} from '../helpers/login-dom-diagnostics.mjs'
test('loading accessible icon survives independently of text and button loading class',()=>{
 document.body.innerHTML='<main class="dy-login"><button type="submit"><span role="img" aria-label="loading"></span><span>登录</span></button></main>'
 const snapshot=loginDomSnapshot()
 expect(snapshot.loadingSubmits).toBe(0);expect(snapshot.loginLabel).toBe(true);expect(snapshot.loadingIcons).toBe(1)
})
test('fixed flags separate hidden inert and explicitly labelled controls without leaking attributes',async()=>{
 document.body.innerHTML='<main class="dy-login"><section inert aria-hidden="true"><button type="submit" aria-label="SECRET" aria-labelledby="SECRET">登录</button></section></main>'
 const snapshot=loginDomSnapshot()
 expect(snapshot.hiddenSubmits).toBe(1);expect(snapshot.inertSubmits).toBe(1);expect(snapshot.explicitLoginLabel).toBe(false);expect(snapshot.labelledBy).toBe(true)
 const lines:string[]=[];await reportLoginDom({evaluate:async()=>({...snapshot,secret:'SECRET'})},line=>lines.push(line))
 expect(lines[0]).not.toContain('SECRET')
})
test('positive box and center hit are reported as booleans only',()=>{
 document.body.innerHTML='<main class="dy-login"><button type="submit">登录</button></main>'
 const button=document.querySelector('button')!
 button.getBoundingClientRect=()=>({x:10,y:20,width:100,height:40} as DOMRect)
 document.elementFromPoint=()=>button
 expect(loginDomSnapshot().submitHasBox).toBe(true);expect(loginDomSnapshot().submitCenterHit).toBe(true)
 document.elementFromPoint=()=>document.body
 expect(loginDomSnapshot().submitCenterHit).toBe(false)
})
test('login root itself can hide or inert its submit button',()=>{
 document.body.innerHTML='<main class="dy-login" aria-hidden="true" inert><button type="submit">登录</button></main>'
 expect(loginDomSnapshot().hiddenSubmits).toBe(1)
 expect(loginDomSnapshot().inertSubmits).toBe(1)
 document.querySelector('main')!.removeAttribute('aria-hidden')
 document.querySelector('main')!.removeAttribute('inert')
 expect(loginDomSnapshot().hiddenSubmits).toBe(0)
 expect(loginDomSnapshot().inertSubmits).toBe(0)
})
