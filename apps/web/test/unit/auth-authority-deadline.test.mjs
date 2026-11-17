import test from 'node:test'
import assert from 'node:assert/strict'
import {createSessionService,tokenHash} from '../../server/src/modules/auth/sessions.ts'
// Controlled database clock exercises the real authority wrapper. These are not
// substitutes for the PostgreSQL lock/rollback integration suite.
function fixture({ttl=1000,idleMs=1000,recentAge=0}={}) {
 const deploymentId='11111111-1111-4111-8111-111111111111',userId='22222222-2222-4222-8222-222222222222',sessionId='33333333-3333-4333-8333-333333333333',token='a'.repeat(43);
 let now=Date.now(),commits=0,rollbacks=0,writes=0;
 const user={id:userId,deployment_id:deploymentId,username_normalized:'admin',display_name:'',status:'active',password_reset_required:false,auth_version:1};
 const session={id:sessionId,user_id:userId,token_hash:tokenHash(token),auth_version:1,expires_at:new Date(now+ttl),last_seen_at:new Date(now),created_at:new Date(now-recentAge),revoked_at:null,reauthenticated_at:null};
 const connection={query:async sql=>{
  if(sql.includes('SELECT * FROM users'))return {rows:[user]};
  if(sql.includes('SELECT * FROM sessions'))return {rows:[session]};
  if(sql.startsWith('SELECT clock_timestamp() AS now,ARRAY('))return {rows:[{now:new Date(now),roles:['config_admin','personal']}]};
  if(sql==='SELECT clock_timestamp() AS now')return {rows:[{now:new Date(now)}]};
  if(sql.includes('SELECT role FROM user_roles'))return {rows:[{role:'config_admin'},{role:'personal'}]};
  if(sql.includes('UPDATE sessions SET last_seen_at'))return {rows:[]};
  throw Error(sql);
 }};
 const db={pool:{query:async sql=>sql.includes('SELECT s.id')?{rows:[{id:sessionId,user_id:userId}]}:{rows:[{role:'config_admin'}],rowCount:1}},transaction:async operation=>{try{const result=await operation(connection);commits++;return result}catch(error){writes=0;rollbacks++;throw error}}};
 const service=createSessionService({db,accounts:{},deploymentId,idleMs,absoluteMs:Math.max(idleMs,ttl)});
 return {run:(options,operation)=>service.withAuthority(token,options,operation),advance:ms=>{now+=ms},write:()=>writes++,session,user,stats:()=>({commits,rollbacks,writes})};
}
for(const [name,config,options,delay,statusCode] of [
 ['absolute expiry',{ttl:50},{},50,401],
 ['idle expiry',{idleMs:50},{},50,401],
 ['recent proof expiry',{recentAge:899999},{requireRecent:true},2,403],
])test(`authority rolls back mutation crossing ${name}`,async()=>{
 const f=fixture(config);await assert.rejects(()=>f.run(options,async()=>{f.write();f.advance(delay)}),{statusCode});
 assert.deepEqual(f.stats(),{commits:0,rollbacks:1,writes:0});
});
test('valid authority commits the callback return value',async()=>{const f=fixture();assert.equal(await f.run({},async()=>{f.write();f.advance(1);return 42}),42);assert.deepEqual(f.stats(),{commits:1,rollbacks:0,writes:1})});
test('self invalidation and token rotation are not rejected by a stale token lookup',async()=>{const f=fixture();await f.run({},async()=>{f.session.revoked_at=new Date();f.session.token_hash='b'.repeat(64);f.user.auth_version++;f.write()});assert.equal(f.stats().commits,1)});
test('self invalidation cannot extend the captured absolute deadline',async()=>{const f=fixture({ttl:50});await assert.rejects(()=>f.run({},async()=>{f.session.expires_at=new Date(Date.now()+999999);f.advance(50);f.write()}),{statusCode:401});assert.equal(f.stats().writes,0)});
test('callback errors propagate without commit',async()=>{const f=fixture();await assert.rejects(()=>f.run({},async()=>{throw Error('failure')}),/failure/);assert.equal(f.stats().commits,0)});
test('already stale recent proof rejects before callback',async()=>{const f=fixture({recentAge:900001});let called=false;await assert.rejects(()=>f.run({requireRecent:true},async()=>{called=true}),{statusCode:403});assert.equal(called,false)});
test('ordinary operations do not require recent proof',async()=>{const f=fixture({recentAge:900001});assert.equal(await f.run({},async()=>42),42)});
