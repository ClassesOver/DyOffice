import test from 'node:test'
import assert from 'node:assert/strict'
import {restrictedFixture} from '../helpers/restricted.mjs'
import {createSkillService} from '../../server/src/modules/skills/service.ts'
import {tokenHash} from '../../server/src/modules/auth/sessions.ts'
import {createStyleTemplateService} from '../../server/src/modules/style-templates/service.ts'

// Removing owner binding, FORCE RLS, or the live session check must break this test.
test('Skills with the same name stay private to each user including config admins and direct SQL', async t => {
  const f = await restrictedFixture(t), skills = createSkillService(f.transactions)
  await skills.save(f.alice.token, 'report', {description: 'Alice only', body: '# Alice private steps'})
  await skills.save(f.bob.token, 'report', {description: 'Bob only', body: '# Bob private steps'})
  assert.deepEqual(await skills.list(f.adminSigned.token), [])
  assert.equal((await skills.read(f.alice.token, 'report')).body, '# Alice private steps')
  assert.equal((await skills.read(f.bob.token, 'report')).body, '# Bob private steps')
  await assert.rejects(skills.read(f.adminSigned.token, 'report'), {statusCode: 404})
  await f.transactions.withPrincipalTransaction({kind: 'session', token: f.bob.token}, async c => {
    await c.query("SELECT set_config('dyoffice.global_session_hash',$1,true),set_config('dyoffice.global_idle_ms',$2,true)", [tokenHash(f.bob.token), String(f.transactions.sessionIdleMs)])
    assert.deepEqual((await c.query('SELECT body FROM user_skills')).rows, [{body: '# Bob private steps'}])
    await c.query("SELECT set_config('dyoffice.user_id',$1,true)", [f.alice.user.id])
    assert.equal((await c.query('SELECT body FROM user_skills')).rowCount, 0)
  })
  assert.equal((await f.businessPool.query('SELECT * FROM user_skills')).rowCount, 0)
  await skills.remove(f.bob.token, 'report')
  assert.deepEqual(await skills.list(f.bob.token), [])
  assert.equal((await skills.list(f.alice.token))[0].description, 'Alice only')
  await f.sessions.logout(f.alice.token)
  await assert.rejects(skills.read(f.alice.token, 'report'), {statusCode: 401})
})

test('PPTX style templates with the same name stay private to each user under RLS',async t=>{
 const f=await restrictedFixture(t),templates=createStyleTemplateService(f.transactions)
 const data=(topic,styleSkill)=>({topic,styleSkill,createdAt:'2026-11-19T00:00:00.000Z',layout:{canvas:{w:1280,h:720}}})
 await templates.save(f.alice.token,'Quarterly / report',data('Alice topic','Alice style'))
 await templates.save(f.bob.token,'Quarterly / report',data('Bob topic','Bob style'))
 assert.equal((await templates.list(f.alice.token))[0].name,'Quarterly _ report')
 assert.equal((await templates.load(f.alice.token,'Quarterly _ report')).styleSkill,'Alice style')
 assert.equal((await templates.load(f.bob.token,'Quarterly _ report')).styleSkill,'Bob style')
 assert.deepEqual(await templates.list(f.adminSigned.token),[])
 assert.deepEqual(await templates.load(f.adminSigned.token,'Quarterly _ report'),{ok:false,error:'Style template not found.'})
 await f.transactions.withPrincipalTransaction({kind:'session',token:f.bob.token},async c=>{
  await c.query("SELECT set_config('dyoffice.global_session_hash',$1,true),set_config('dyoffice.global_idle_ms',$2,true)",[tokenHash(f.bob.token),String(f.transactions.sessionIdleMs)])
  assert.deepEqual((await c.query('SELECT style_skill FROM user_style_templates')).rows,[{style_skill:'Bob style'}])
  await c.query("SELECT set_config('dyoffice.user_id',$1,true)",[f.alice.user.id])
  assert.equal((await c.query('SELECT style_skill FROM user_style_templates')).rowCount,0)
 })
 assert.equal((await f.businessPool.query('SELECT * FROM user_style_templates')).rowCount,0)
})

test('Skills API derives ownership from cookie, rejects injected principals, and requires CSRF on writes', async t => {
  const f = await restrictedFixture(t)
  const cookie = '__Host-dyoffice-session=' + f.alice.token
  const headers = {cookie, origin: 'https://office.example'}
  const proof = await f.app.inject({url: '/api/v1/auth/csrf', headers})
  headers['x-csrf-token'] = proof.json().csrfToken
  const path = '/api/v1/skills/report'
  const draft = {description: 'Private', body: '# Personal skill'}
  assert.equal((await f.app.inject({method: 'PUT', url: path, headers: {cookie}, payload: draft})).statusCode, 403)
  assert.equal((await f.app.inject({method: 'PUT', url: path, headers, payload: {...draft, ownerId: f.bob.user.id}})).statusCode, 400)
  assert.equal((await f.app.inject({method: 'PUT', url: path, headers, payload: draft})).statusCode, 200)
  assert.equal((await f.app.inject({url: path, headers: {cookie: '__Host-dyoffice-session=' + f.bob.token, 'x-csrf-token': (await f.app.inject({url: '/api/v1/auth/csrf', headers: {cookie: '__Host-dyoffice-session=' + f.bob.token}})).json().csrfToken}})).statusCode, 404)
  assert.equal((await f.app.inject({url: path + '?ownerId=' + f.alice.user.id, headers})).statusCode, 400)
  const result = await f.app.inject({url: '/api/v1/skills', headers})
  assert.deepEqual(result.json(), [{name: 'report', description: 'Private'}])
  assert.match(result.headers['cache-control'], /no-store/)
  assert.equal((await f.app.inject({method: 'DELETE', url: path, headers})).statusCode, 204)
})

test('concurrent create-only Skills admit one writer without overwriting its description or body',async t=>{
 const f=await restrictedFixture(t,{businessMax:4}),skills=createSkillService(f.transactions)
 const drafts=[{description:'Word first',body:'First original Word steps',overwrite:false},{description:'Word second',body:'Second original Word steps',overwrite:false}]
 const results=await Promise.allSettled(drafts.map(draft=>skills.save(f.alice.token,'atomic-report',draft)))
 assert.equal(results.filter(result=>result.status==='fulfilled').length,1)
 assert.equal(results.find(result=>result.status==='rejected').reason.statusCode,409)
 const winner=drafts[results.findIndex(result=>result.status==='fulfilled')]
 assert.deepEqual(await skills.read(f.alice.token,'atomic-report'),{name:'atomic-report',description:winner.description,body:winner.body})
 await assert.rejects(skills.save(f.alice.token,'atomic-report',{description:'Word intruder',body:'Overwrite attempt',overwrite:false}),{statusCode:409})
 assert.equal((await skills.read(f.alice.token,'atomic-report')).body,winner.body)
 await skills.save(f.alice.token,'atomic-report',{description:'Word explicit replacement',body:'Explicit new steps',overwrite:true})
 assert.equal((await skills.read(f.alice.token,'atomic-report')).body,'Explicit new steps')
 await skills.save(f.alice.token,'atomic-report',{description:'Word legacy update',body:'Legacy compatible steps'})
 assert.equal((await skills.read(f.alice.token,'atomic-report')).body,'Legacy compatible steps')
 for(const overwrite of ['false',0,null,{}])await assert.rejects(skills.save(f.alice.token,'invalid-flag',{description:'Word draft',body:'Draft',overwrite}),{statusCode:400})
})

test('Skills HTTP create-only requests conflict atomically and reject nonboolean overwrite flags',async t=>{
 const f=await restrictedFixture(t),cookie='__Host-dyoffice-session='+f.alice.token,headers={cookie,origin:'https://office.example'}
 headers['x-csrf-token']=(await f.app.inject({url:'/api/v1/auth/csrf',headers})).json().csrfToken
 const url='/api/v1/skills/http-atomic',draft={description:'Word first',body:'Keep original',overwrite:false}
 assert.equal((await f.app.inject({method:'PUT',url,headers,payload:draft})).statusCode,200)
 assert.equal((await f.app.inject({method:'PUT',url,headers,payload:{...draft,body:'Should not replace'}})).statusCode,409)
 assert.equal((await f.app.inject({url,headers})).json().body,'Keep original')
 for(const overwrite of ['false',1,null,{}])assert.equal((await f.app.inject({method:'PUT',url,headers,payload:{...draft,overwrite}})).statusCode,400)
 assert.equal((await f.app.inject({method:'PUT',url,headers,payload:{...draft,overwrite:true,body:'Explicit replacement'}})).statusCode,200)
 assert.equal((await f.app.inject({url,headers})).json().body,'Explicit replacement')
})
