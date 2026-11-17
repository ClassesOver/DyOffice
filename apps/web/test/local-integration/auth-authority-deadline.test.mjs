import test from 'node:test'
import assert from 'node:assert/strict'
import {restrictedIdentityFixture} from '../helpers/restricted-identity.mjs'
import {password} from '../helpers/identity.mjs'
import {createSessionService} from '../../server/src/modules/auth/sessions.ts'

test('successful requests within 30 seconds refresh the persisted idle deadline', { timeout: 15_000 }, async t => {
 const f=await restrictedIdentityFixture(t)
 const sessions=createSessionService({db:f.db,accounts:f.accounts,deploymentId:f.deploymentId,idleMs:10_000})
 const signed=await sessions.login('owner',password)
 const previous=(await f.pool.query("UPDATE sessions SET last_seen_at=clock_timestamp()-interval '9 seconds' WHERE id=$1 RETURNING last_seen_at",[signed.sessionId])).rows[0].last_seen_at
 await sessions.authenticate(signed.token)
 const refreshed=(await f.pool.query('SELECT last_seen_at FROM sessions WHERE id=$1',[signed.sessionId])).rows[0].last_seen_at
 assert.ok(refreshed.getTime()>previous.getTime()+8_000,'last_seen must reflect the successful request, even below the old 30 second throttle')
 await f.pool.query('SELECT pg_sleep(1.2)')
 await sessions.authenticate(signed.token)
 await f.pool.query("UPDATE sessions SET last_seen_at=clock_timestamp()-interval '10 seconds' WHERE id=$1",[signed.sessionId])
 await assert.rejects(()=>sessions.authenticate(signed.token),{statusCode:401})
})

for (const boundary of ['absolute','recent']) test(`account mutation crossing ${boundary} deadline rolls back in PostgreSQL`,{timeout:15000},async t=>{
 const f=await restrictedIdentityFixture(t);
 const sessions=createSessionService({db:f.db,accounts:f.accounts,deploymentId:f.deploymentId});
 const signed=await sessions.login('owner',password);
 await f.pool.query(boundary==='absolute'
  ? "UPDATE sessions SET expires_at=clock_timestamp()+interval '500 milliseconds' WHERE id=$1"
  : "UPDATE sessions SET created_at=clock_timestamp()-interval '15 minutes'+interval '500 milliseconds',reauthenticated_at=NULL WHERE id=$1",[signed.sessionId]);
 const before=(await f.pool.query('SELECT display_name FROM users WHERE id=$1',[f.user.id])).rows[0].display_name;
 let entered=false;
 await assert.rejects(()=>sessions.withAuthority(signed.token,{lockUsers:'update',requireAdmin:true,requireRecent:true},async({connection})=>{
  entered=true;
  await connection.query("UPDATE users SET display_name='must rollback' WHERE id=$1",[f.user.id]);
  await connection.query('SELECT pg_sleep(0.7)');
 }),{statusCode:boundary==='absolute'?401:403});
 assert.equal(entered,true,'test must cross the deadline inside the operation');
 assert.equal((await f.pool.query('SELECT display_name FROM users WHERE id=$1',[f.user.id])).rows[0].display_name,before);
});
