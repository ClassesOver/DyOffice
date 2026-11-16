import test from 'node:test'
import assert from 'node:assert/strict'
import {restrictedIdentityFixture} from '../helpers/restricted-identity.mjs'
import {password} from '../helpers/identity.mjs'
import {createSessionService} from '../../server/src/modules/auth/sessions.ts'

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
