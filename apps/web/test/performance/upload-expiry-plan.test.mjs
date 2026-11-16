import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { fileFixture } from '../helpers/files.mjs'

test('upload expiry indexed cutoff experiment', { skip: process.env.DYOFFICE_RUN_EXPIRY_BENCHMARK !== 'synthetic-local-only' }, async t => {
 const f = await fileFixture(t)
 await f.files.usage(f.alice.token)
 const values = [f.deploymentId, f.alice.user.id]
 await f.transactions.withPrincipalTransaction({ kind: 'session', token: f.alice.token }, async (c,p) => {
   const workspace = (await c.query('SELECT workspace_id FROM storage_accounts WHERE deployment_id=$1 AND owner_id=$2',values)).rows[0].workspace_id
   await c.query(`INSERT INTO uploads(id,deployment_id,owner_id,workspace_id,file_id,revision_id,name,format,expected_size,auth_version,state,expires_at)
     SELECT gen_random_uuid(),$1,$2,$3,gen_random_uuid(),gen_random_uuid(),'fixture.docx','docx',1,1,'staged',clock_timestamp()+interval '1 day' FROM generate_series(1,20000)`,[...values,workspace])
   await c.query('UPDATE storage_accounts SET reserved_bytes=20000 WHERE deployment_id=$1 AND owner_id=$2',values)
 })
 await f.ownerPool.query('ANALYZE uploads')
 const samples = []
 for (let round=0;round<4;round++) for (const mode of (round%2?['fixed','volatile']:['volatile','fixed'])) {
   const cutoff = mode==='fixed'?'statement_timestamp()':'clock_timestamp()'
   const result = await f.transactions.withPrincipalTransaction({ kind: 'session', token: f.alice.token }, async c => c.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT id,expected_size,state FROM uploads WHERE deployment_id=$1 AND owner_id=$2 AND state IN ('staged','receiving','ready') AND expires_at<=${cutoff} ORDER BY id FOR UPDATE`,values))
   samples.push({round,warmup:round===0,mode,plan:result.rows[0]['QUERY PLAN'][0]})
 }
 assert.ok(process.env.DYOFFICE_EXPIRY_REPORT)
 await writeFile(process.env.DYOFFICE_EXPIRY_REPORT,JSON.stringify({node:process.version,rows:20000,description:'Single-owner 20000 live uploads, no expired rows; scoped runtime role, warmup plus three alternating explain-analyze samples. Only cleanup selector measured, not service latency.',samples},null,2))
})
