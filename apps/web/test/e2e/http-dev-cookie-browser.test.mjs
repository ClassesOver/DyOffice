// Browser protocol fixture uses real auth routes but mocked DB/session storage.
// This is NOT Docker or full PostgreSQL-backed login acceptance.
import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import Fastify from 'fastify'
import {chromium} from '@playwright/test'
import {createCsrfService} from '../../server/src/modules/auth/csrf.ts'
import {registerAuthRoutes} from '../../server/src/modules/auth/routes.ts'
test('Chromium non-localhost HTTP dev-cookie login, refresh, logout protocol',async()=>{
 const old=process.env.NODE_ENV;process.env.NODE_ENV='development'
 let app,browser,live=false
 const server=createServer((req,res)=>app.routing(req,res))
 try{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 const origin=`http://dyoffice-http.test:${server.address().port}`
 const csrf=createCsrfService({db:{pool:{async query(){return {rowCount:1,rows:[]}}}},deploymentId:'fixture',origin,key:'k'.repeat(32),insecureHttpDev:true})
 app=Fastify();app.addHook('onRequest',async req=>csrf.bindRequest(req))
 app.get('/',async(_req,reply)=>reply.type('text/html').send('<!doctype html><title>HTTP dev auth fixture</title>'))
 const token=csrf.sessionCredentials.issue()
 registerAuthRoutes(app,{csrf,users:{},throttle:{async reserve(){return {}}},sessions:{async login(){live=true;return {token,user:{id:'u'}}},async authenticate(t){if(!live||t!==token)throw Object.assign(new Error('Unauthorized'),{statusCode:401});return {userId:'u',roles:[]}},async logout(){live=false}}})
 await app.ready()
 browser=await chromium.launch({headless:true,...(process.env.DYOFFICE_BROWSER_EXECUTABLE?{executablePath:process.env.DYOFFICE_BROWSER_EXECUTABLE}:{}),args:['--no-sandbox','--no-proxy-server','--host-resolver-rules=MAP dyoffice-http.test 127.0.0.1']})
 const page=await browser.newPage();await page.goto(origin)
 const signed=await page.evaluate(async()=>{
  const c=await(await fetch('/api/v1/auth/csrf')).json()
  const r=await fetch('/api/v1/auth/login',{method:'POST',headers:{'content-type':'application/json','x-csrf-token':c.csrfToken},body:JSON.stringify({username:'admin',password:'fixture-password-only'})})
  return {status:r.status,body:await r.json(),visible:document.cookie}
 })
 assert.equal(signed.status,200);assert.equal(signed.visible.includes('dyoffice-dev'),false)
 const jar=await page.context().cookies();const session=jar.find(c=>c.name==='dyoffice-dev-session');assert.ok(session);assert.equal(session.secure,false);assert.equal(session.httpOnly,true);assert.equal(session.sameSite,'Lax')
 await page.reload();assert.equal(await page.evaluate(async()=>(await fetch('/api/v1/auth/me')).status),200)
 const logout=await page.evaluate(async csrfToken=>(await fetch('/api/v1/auth/logout',{method:'POST',headers:{'x-csrf-token':csrfToken}})).status,signed.body.csrfToken)
 assert.equal(logout,204);assert.equal((await page.context().cookies()).some(c=>c.name==='dyoffice-dev-session'),false)
 assert.equal(await page.evaluate(async()=>(await fetch('/api/v1/auth/me')).status),401)
 }finally{await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await app?.close();if(old===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=old}
})
