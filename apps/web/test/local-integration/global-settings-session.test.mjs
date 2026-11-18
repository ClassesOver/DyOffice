import test from 'node:test'
import assert from 'node:assert/strict'
import {restrictedFixture,restrictedOrigin} from '../helpers/restricted.mjs'
import {password} from '../helpers/identity.mjs'
import {buildLocalApp} from '../../server/src/app.ts'
import {createLocalShellClient} from '../../src/shell/local-client.ts'
import {createLocalGlobalSettingsSession} from '../../src/shell/local-global-settings-session.ts'

test('real HTTP and PG reject an old workspace configuration write after the cookie changes to another authorized admin',{timeout:30000},async t=>{
 const f=await restrictedFixture(t,{businessMax:4,buildApp:false})
 await f.users.update(f.adminSigned.token,f.alice.user.id,{roles:['personal','config_admin']})
 const second=await f.sessions.login('alice',password)
 const keyring={activeKeyId:'test',keys:{test:new Uint8Array(32).fill(19)}}
 const app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin:restrictedOrigin,csrfKey:f.csrfKey,globalConfigKeyring:keyring})
 f.cleanup.push(()=>app.close())
 await app.listen({host:'127.0.0.1',port:0});const origin=`http://127.0.0.1:${app.server.address().port}`
 let cookie=f.adminSigned.token,writes=0,recovery=0
 const send=async(path,init={})=>{
  if(init.method==='PUT')writes++
  return fetch(origin+path,{...init,headers:{...Object.fromEntries(new Headers(init.headers)),cookie:'__Host-dyoffice-session='+cookie,origin:restrictedOrigin}})
 }
 const client=createLocalShellClient(send),session=createLocalGlobalSettingsSession(client)
 client.onSessionEnded(()=>recovery++)
 session.bind(await client.bindSession())
 const initial=await session.settings.load()
 cookie=second.token
 await assert.rejects(session.settings.save(initial.revision,{defaults:{chat:null}}),{code:'stale_session'})
 assert.equal(recovery,1);assert.equal(writes,1,'the denied request is never retried with the replacement proof')
 assert.equal(session.settings.getState().unknownWrite,false,'403 is a definite pre-write rejection')
 // Recreate a workspace only after explicitly authenticating its owner, as a full
 // reload would. B is genuinely authorized, not a permission-denial substitute.
 const fresh=createLocalShellClient(send),next=createLocalGlobalSettingsSession(fresh)
 const bound=await fresh.bindSession();assert.equal((await bound.request('/api/v1/auth/me')).user.id,f.alice.user.id);next.bind(bound)
 assert.equal((await next.settings.load()).revision,initial.revision,'A draft did not mutate configuration as B')
 assert.equal((await next.settings.save(initial.revision,{defaults:{chat:null}})).revision,initial.revision+1)
 assert.equal(writes,2)
})
