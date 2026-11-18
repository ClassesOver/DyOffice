import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import {createCsrfService,cookies,serializeCookie,SESSION_COOKIE,LOGIN_COOKIE} from '../../server/src/modules/auth/csrf.ts'
import {registerAuthRoutes} from '../../server/src/modules/auth/routes.ts'
const previous=process.env.NODE_ENV
process.env.NODE_ENV='development'
const token='a'.repeat(43),origin='http://192.168.2.7:3080',host='192.168.2.7:3080'
const db={pool:{async query(){return {rowCount:1,rows:[]}}}}
const make=(extra={})=>createCsrfService({db,deploymentId:'test',origin,key:'k'.repeat(32),insecureHttpDev:true,...extra})
function request(headers={}){return {headers,raw:{rawHeaders:Object.entries(headers).flat()}}}
test.after(()=>{if(previous===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=previous})
test('default remote HTTP fails, production/test/unset opt-in fails, HTTPS cannot enable insecure mode',()=>{
 assert.throws(()=>make({insecureHttpDev:false}),/canonical origin/)
 for(const env of ['production','test',undefined]){if(env===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=env;assert.throws(()=>make(),/explicit development/)}
 process.env.NODE_ENV='development'
 assert.throws(()=>make({origin:'https://office.example'}),/explicit development/)
 for(const bad of ['http://user:pw@office.test','http://office.test/path','http://office.test/','http://office.test?x=1'])assert.throws(()=>make({origin:bad}))
})
test('secure defaults and independent dev cookie names; logout remains in same mode',()=>{
 assert.match(serializeCookie(SESSION_COOKIE,token),/^__Host-.*; HttpOnly; Secure;/)
 const dev=make(),secure=make({origin:'https://office.example',insecureHttpDev:false})
 const issued=dev.sessionCredentials.issue()
 assert.equal(dev.serializeCookie(SESSION_COOKIE,issued),`dyoffice-dev-session=${issued}; Path=/; HttpOnly; SameSite=Lax`)
 assert.match(dev.serializeCookie(LOGIN_COOKIE,'',0),/^dyoffice-dev-login=;.*Max-Age=0$/)
 assert.match(secure.serializeCookie(SESSION_COOKIE,token),/Secure;/)
})
test('exact Host and Origin, duplicate headers, proxy spoofing and cross-site writes fail',()=>{
 const csrf=make()
 for(const headers of [
  {host:'evil.test',origin},{host,origin:'http://evil.test'}, {host},
  {host,origin,'sec-fetch-site':'cross-site'},
  {host:'evil.test',origin,'x-forwarded-host':host,'x-forwarded-proto':'http'},
 ])assert.throws(()=>csrf.originCheck(request(headers),true))
 const dup=request({host,origin});dup.raw.rawHeaders.push('Host',host);assert.throws(()=>csrf.originCheck(dup))
 const dupOrigin=request({host,origin});dupOrigin.raw.rawHeaders.push('Origin',origin);assert.throws(()=>csrf.originCheck(dupOrigin))
 assert.doesNotThrow(()=>csrf.originCheck(request({host,origin,'sec-fetch-site':'same-origin'})))
})
test('modes reject the other cookie names; no process-global mode leakage',()=>{
 const dev=make(),secure=make({origin:'https://office.example',insecureHttpDev:false})
 const devToken=dev.sessionCredentials.issue()
 const a=request({host,cookie:`dyoffice-dev-session=${devToken}`});dev.bindRequest(a);assert.equal(cookies(a).session,devToken)
 const b=request({host:'office.example',cookie:`${SESSION_COOKIE}=${token}`});secure.bindRequest(b);assert.equal(cookies(b).session,token)
 assert.throws(()=>cookies(request({cookie:`dyoffice-dev-session=${token}`})))
 const wrong=request({host,cookie:`${SESSION_COOKIE}=${token}`});dev.bindRequest(wrong);assert.throws(()=>cookies(wrong))
 secure.bindRequest(a);assert.throws(()=>cookies(a))
})
test('WS-shaped raw request enforces the same Host/origin and CSRF token policy',()=>{
 const csrf=make(),token=csrf.sessionCredentials.issue(),req=request({host,origin,cookie:`dyoffice-dev-session=${token}`,'x-csrf-token':csrf.sessionToken(token)})
 csrf.originCheck(req,true);assert.equal(cookies(req).session,token);csrf.requireSession(req,token)
 delete req.headers['x-csrf-token'];assert.throws(()=>csrf.requireSession(req,token))
})
test('real auth routes issue dev login/session cookies, reject wrong CSRF and logout',async()=>{
 const app=Fastify(),csrf=make(),token=csrf.sessionCredentials.issue();let live=false
 app.addHook('onRequest',async req=>csrf.bindRequest(req))
 const sessions={async login(){live=true;return {token,user:{id:'u'}}},async authenticate(t){if(!live||t!==token)throw Object.assign(new Error('Unauthorized'),{statusCode:401});return {userId:'u',roles:[]}},async logout(){live=false}}
 registerAuthRoutes(app,{csrf,sessions,users:{},throttle:{async reserve(){return {}}}})
 try{
 const challenge=await app.inject({url:'/api/v1/auth/csrf',headers:{host,origin}});assert.equal(challenge.statusCode,200)
 const loginCookie=challenge.headers['set-cookie'][0].split(';')[0];assert.match(loginCookie,/^dyoffice-dev-login=/)
 const headers={host,origin,cookie:loginCookie,'x-csrf-token':challenge.json().csrfToken}
 const payload={username:'admin',password:'development-only-password'}
 const rejected=await app.inject({method:'POST',url:'/api/v1/auth/login',headers:{...headers,'x-csrf-token':'b'.repeat(43)},payload});assert.equal(rejected.statusCode,403)
 const signed=await app.inject({method:'POST',url:'/api/v1/auth/login',headers,payload});assert.equal(signed.statusCode,200)
 const session=signed.headers['set-cookie'][0].split(';')[0];assert.match(session,/^dyoffice-dev-session=/)
 const logout=await app.inject({method:'POST',url:'/api/v1/auth/logout',headers:{host,origin,cookie:session,'x-csrf-token':signed.json().csrfToken}});assert.equal(logout.statusCode,204);assert.ok(logout.headers['set-cookie'].every(v=>v.includes('Max-Age=0')&&!v.includes('Secure')))
 const me=await app.inject({url:'/api/v1/auth/me',headers:{host,cookie:session}});assert.equal(me.statusCode,401)
 }finally{await app.close()}
})
test('dev tokens cannot be renamed or stripped into secure sessions; secure tokens cannot become dev',async()=>{
 const {createSessionService,tokenHash}=await import('../../server/src/modules/auth/sessions.ts')
 const dev=make(),secure=make({origin:'https://office.example',insecureHttpDev:false})
 const saved=new Map(),queried=[]
 const user={id:'u',status:'active',password_reset_required:false,auth_version:1,username_normalized:'u',display_name:'U'}
 const connection={async query(sql,args){
  if(sql.startsWith('SELECT * FROM users'))return {rows:[user]}
  if(sql.startsWith('INSERT INTO sessions')){saved.set(args[3],{id:args[0],user_id:'u'});return {rows:[]}}
  if(sql.includes('FROM user_roles'))return {rows:[]}
  return {rows:[],rowCount:1}
 }}
 const store={async transaction(fn){return fn(connection)},pool:{async query(sql,args){queried.push(args[1]);return {rows:saved.has(args[1])?[saved.get(args[1])]:[]}}}}
 const accounts={async verifyCredentials(){return {userId:'u',authVersion:1}}}
 const service=policy=>createSessionService({db:store,accounts,deploymentId:'d',credentials:policy.sessionCredentials})
 const devSessions=service(dev),secureSessions=service(secure)
 const issued=await devSessions.login('u','p'),oldSecure=await secureSessions.login('u','p')
 assert.ok(saved.has(tokenHash(issued.token)));assert.ok(saved.has(tokenHash(oldSecure.token)))
 assert.notEqual(dev.sessionToken(oldSecure.token),secure.sessionToken(oldSecure.token))
 await assert.rejects(()=>secureSessions.authenticate(issued.token))
 await assert.rejects(()=>devSessions.authenticate(oldSecure.token))
 const nonce=issued.token.split('.')[1]
 await assert.rejects(()=>secureSessions.authenticate(nonce))
 assert.equal(queried.at(-1),tokenHash(nonce));assert.equal(saved.has(tokenHash(nonce)),false)
 const renamed=request({host:'office.example',cookie:`${SESSION_COOKIE}=${issued.token}`});secure.bindRequest(renamed);assert.throws(()=>cookies(renamed))
 const other=request({host,cookie:`dyoffice-dev-session=${oldSecure.token}`});dev.bindRequest(other);assert.throws(()=>cookies(other))
 assert.throws(()=>make({origin:'http://192.168.2.8:3080'}).sessionCredentials.verify(issued.token))
 assert.throws(()=>make({deploymentId:'other'}).sessionCredentials.verify(issued.token))
 assert.throws(()=>make({key:'z'.repeat(32)}).sessionCredentials.verify(issued.token))
 // Turning off the mode keeps legacy secure token validation, never a dev fallback.
 secure.sessionCredentials.verify(oldSecure.token)
 assert.throws(()=>secure.sessionCredentials.verify(issued.token))
})
