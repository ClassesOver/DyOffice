import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request as rawRequest } from 'node:http'
import { randomUUID } from 'node:crypto'
import { createLocalAuthHttpAdapter } from '../server/auth/http-auth-adapter.mjs'

const origin='https://office.example.test'
const deploymentId=randomUUID()
const principal={sessionId:randomUUID(),deploymentId,userId:randomUUID(),roles:['user'],expiresAt:new Date().toISOString()}
const COOKIE='__Host-dyoffice_session='+'A'.repeat(43)

async function fixture(t) {
  const calls={logins:[],authenticated:0,revoked:0}
  let loginResult={ok:true,cookie:COOKIE+'; Path=/; HttpOnly; Secure; SameSite=Lax'}
  const loginService={ async login(value){calls.logins.push(value);return loginResult} }
  const sessionService={
    async authenticate(req,{deploymentId:dep}){
      assert.equal(dep,deploymentId)
      calls.authenticated++
      return req.headers.cookie===COOKIE?principal:null
    },
    async revoke(req,{deploymentId:dep}){
      assert.equal(dep,deploymentId);calls.revoked++;return req.headers.cookie===COOKIE
    },
  }
  const csrfPolicy={issue(p){assert.equal(p.sessionId,principal.sessionId);return 'safe-csrf-token'},verify(req,p){return p.sessionId===principal.sessionId&&req.headers['x-dyoffice-csrf']==='safe-csrf-token'&&req.headers.origin===origin}}
  const handler=createLocalAuthHttpAdapter({loginService,sessionService,csrfPolicy, deploymentId,trustedOrigin:origin})
  const server=createServer(async(req,res)=>{
    try{if(!await handler(req,res)){res.writeHead(404);res.end('Not found')}}
    catch{res.writeHead(500);res.end('Internal error')}
  })
  server.listen(0,'127.0.0.1')
  await new Promise(resolve=>server.once('listening',resolve))
  t.after(()=>new Promise(resolve=>server.close(resolve)))
  return{base:`http://127.0.0.1:${server.address().port}`,calls,setResult(v){loginResult=v}}
}

test('valid login accepts only username/password and uses trusted socket IP',async t=>{
  const f=await fixture(t)
  const success=await fetch(f.base+'/api/v1/auth/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Forwarded-For':'1.2.3.4'},body:JSON.stringify({username:'alice',password:'long-password'})})
  assert.equal(success.status,200)
  assert.equal((await success.json()).ok,true)
  assert.equal(success.headers.get('cache-control'),'no-store')
  assert.ok(success.headers.get('set-cookie').includes('HttpOnly'))
  assert.equal(f.calls.logins[0].ipAddress,'127.0.0.1')
  assert.equal(f.calls.logins[0].username,'alice')
  const bad=await fetch(f.base+'/api/v1/auth/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({username:'alice',password:'pass',userId:'other'})})
  assert.equal(bad.status,400)
  assert.equal(f.calls.logins.length,1)
  const malformed=await fetch(f.base+'/api/v1/auth/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:'{'})
  assert.equal(malformed.status,400)
})

test('Origin spoofing and duplicate Origin headers cannot log in',async t=>{
  const f=await fixture(t)
  const body=JSON.stringify({username:'alice',password:'long-password'})
  for(const sentOrigin of ['https://office.example.test.evil.test','https://evil.example.test']){
    const res=await fetch(f.base+'/api/v1/auth/login',{method:'POST',headers:{Origin:sentOrigin,'Content-Type':'application/json'},body})
    assert.equal(res.status,403)
  }
  const noOrigin=await fetch(f.base+'/api/v1/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body})
  assert.equal(noOrigin.status,403)
  const duplicateStatus=await new Promise((resolve,reject)=>{
    const req=rawRequest(f.base+'/api/v1/auth/login',{method:'POST',headers:{Origin:[origin,origin],'Content-Type':'application/json'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode))})
    req.on('error',reject);req.end(body)
  })
  assert.equal(duplicateStatus,403)
  assert.equal(f.calls.logins.length,0)
})

test('me/csrf require live session and logout requires a session-bound CSRF token',async t=>{
  const f=await fixture(t)
  assert.equal((await fetch(f.base+'/api/v1/auth/me')).status,401)
  const sessionHeaders={Cookie:COOKIE}
  const me=await fetch(f.base+'/api/v1/auth/me',{headers:sessionHeaders})
  assert.equal(me.status,200)
  const meBody=await me.json()
  assert.equal(meBody.userId,principal.userId)
  assert.deepEqual(meBody.roles,['user'])
  const csrf=await fetch(f.base+'/api/v1/auth/csrf',{headers:sessionHeaders})
  assert.equal(csrf.status,200)
  assert.equal((await csrf.json()).csrfToken,'safe-csrf-token')
  assert.equal((await fetch(f.base+'/api/v1/auth/logout',{method:'POST',headers:{...sessionHeaders,Origin:origin}})).status,403)
  const logout=await fetch(f.base+'/api/v1/auth/logout',{method:'POST',headers:{...sessionHeaders,Origin:origin,'X-DyOffice-CSRF':'safe-csrf-token'}})
  assert.equal(logout.status,200)
  assert.equal(f.calls.revoked,1)
  assert.match(logout.headers.get('set-cookie'),/Max-Age=0/)
})

test('login errors and upstream failures are generic; unsupported routes do not get exposed',async t=>{
  const f=await fixture(t)
  f.setResult({ok:false,code:'INVALID_CREDENTIALS'})
  const headers={Origin:origin,'Content-Type':'application/json'}
  let res=await fetch(f.base+'/api/v1/auth/login',{method:'POST',headers,body:'{"username":"alice","password":"x"}'})
  assert.equal(res.status,401)
  assert.equal(JSON.stringify(await res.json()).includes('alice'),false)
  f.setResult({ok:false,code:'RATE_LIMITED'})
  res=await fetch(f.base+'/api/v1/auth/login',{method:'POST',headers,body:'{"username":"alice","password":"x"}'})
  assert.equal(res.status,429)
  f.setResult(null)
  res=await fetch(f.base+'/api/v1/auth/login',{method:'POST',headers,body:'{"username":"alice","password":"x"}'})
  assert.equal(res.status,401)
  assert.equal((await fetch(f.base+'/api/v1/auth/internal',{headers:{Cookie:COOKIE}})).status,404)
  assert.equal((await fetch(f.base+'/api/v1/auth/me',{method:'POST'})).status,405)
})
