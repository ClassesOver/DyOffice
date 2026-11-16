import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileFixture } from '../helpers/files.mjs'
import { lockAccount } from '../../server/src/modules/files/queries.ts'

const owned = (f,fn) => f.transactions.withPrincipalTransaction({ kind:'session',token:f.alice.token },fn)
async function seed(f,count) {
 await f.files.usage(f.alice.token)
 await owned(f, async c => {
  const values=[f.deploymentId,f.alice.user.id]
  const workspace=(await c.query('SELECT workspace_id FROM storage_accounts WHERE deployment_id=$1 AND owner_id=$2',values)).rows[0].workspace_id
  await c.query(`INSERT INTO uploads(id,deployment_id,owner_id,workspace_id,file_id,revision_id,name,format,expected_size,auth_version,state,expires_at)
   SELECT gen_random_uuid(),$1,$2,$3,gen_random_uuid(),gen_random_uuid(),'live.docx','docx',1,1,'staged',clock_timestamp()+interval '1 day' FROM generate_series(1,$4::int)`,[...values,workspace,count])
  await c.query('UPDATE storage_accounts SET reserved_bytes=$3 WHERE deployment_id=$1 AND owner_id=$2',[...values,count])
 })
 await f.ownerPool.query('ANALYZE uploads')
}
function nodes(p) { return [p,...(p.Plans??[]).flatMap(nodes)] }

test('actual account cleanup uses expiry index range rather than scanning all live uploads', async t => {
 const f=await fileFixture(t)
 await seed(f,20000)
 let plan
 await owned(f, async (c,p) => {
  const observed = { query: async (sql,values) => {
   if (sql.startsWith('WITH candidates AS')) plan=(await c.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+sql,values)).rows[0]['QUERY PLAN'][0]
   return c.query(sql,values)
  } }
  const account=await lockAccount(observed,p)
  assert.equal(account.reservedBytes,20000)
  assert.equal(account.storedBytes,0)
 })
 assert.ok(plan)
 assert.ok(nodes(plan.Plan).some(n => n['Index Name']==='uploads_owner_state_expiry' && n['Index Cond']?.includes('expires_at <=')), 'expiry must be a range condition on the existing index')
 assert.ok(nodes(plan.Plan).every(n => (n['Rows Removed by Filter']??0)<100), 'do not inspect every live upload to discover no expired work')
})

test('cleanup cutoff is fresh after transaction start and preserves staged versus published quota accounting', async t => {
 const f=await fileFixture(t)
 await seed(f,4)
 await owned(f,async(c,p)=>{
  const rows=(await c.query('SELECT id FROM uploads ORDER BY id')).rows
  for(let i=0;i<3;i++) await c.query("UPDATE uploads SET state=$2,sha256=$3,expires_at=transaction_timestamp()+interval '400 milliseconds' WHERE id=$1",[rows[i].id,['staged','receiving','ready'][i],i===2?'0'.repeat(64):null])
  assert.equal((await c.query("SELECT clock_timestamp()<transaction_timestamp()+interval '400 milliseconds' AS before_deadline")).rows[0].before_deadline,true)
  await c.query('SELECT pg_sleep(0.5)')
  const account=await lockAccount(c,p)
  assert.equal(account.reservedBytes,1)
  assert.equal(account.storedBytes,2)
  const counts=(await c.query('SELECT state,count(*)::int AS n FROM uploads GROUP BY state')).rows
  assert.deepEqual(Object.fromEntries(counts.map(r=>[r.state,r.n])),{expired:3,staged:1})
  assert.deepEqual(await lockAccount(c,p),account,'cleanup retry must not double count expired payloads')
 })
})
