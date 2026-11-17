import {test} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {Pool} from 'pg'
import {fileFixture,docxBytes,importFile} from '../helpers/files.mjs'
import {loadFile} from '../../server/src/modules/files/queries.ts'
import {waitForDatabaseLock} from '../helpers/restricted.mjs'

for(const lock of ['SHARE','UPDATE']) for(const change of ['revision','trash','purge']) test(`file open (${lock}) waiting on ${change} preserves visibility and head consistency`,async t=>{
 const f=await fileFixture(t,{buildApp:false}), original=(await importFile(f,f.alice.token,await docxBytes())).file
 // Admin SQL only establishes the competing transaction. Reads below use the
 // real authenticated business role and FORCE RLS; no sleeps or auth bypass.
 // The new revision is metadata-only: this test does not claim object persistence.
 const url=new URL(process.env.DYOFFICE_TEST_DATABASE_URL);url.pathname='/'+f.database
 const pool=new Pool({connectionString:url.href}),c=await pool.connect()
 const next=randomUUID()
 try {
  await c.query('BEGIN')
  await c.query('SELECT 1 FROM files WHERE id=$1 FOR UPDATE',[original.fileId])
  await c.query("INSERT INTO file_revisions(id,deployment_id,owner_id,file_id,object_key,sha256,size,source,parent_revision) SELECT $1::uuid,deployment_id,owner_id,file_id,deployment_id::text||'/'||owner_id::text||'/objects/'||($1::uuid)::text,sha256,size,'save',id FROM file_revisions WHERE id=$2",[next,original.revision])
  await c.query('UPDATE files SET current_revision=$1 WHERE id=$2',[next,original.fileId])
  if(change==='trash')await c.query('UPDATE files SET deleted_at=clock_timestamp() WHERE id=$1',[original.fileId])
  if(change==='purge')await c.query('UPDATE files SET deleted_at=clock_timestamp(),purge_started_at=clock_timestamp() WHERE id=$1',[original.fileId])
  const opening=(lock==='SHARE'?f.files.openFile(f.alice.token,original.fileId):f.transactions.withPrincipalTransaction({kind:'session',token:f.alice.token},async(c,p)=>({file:{revision:(await loadFile(c,p,original.fileId,false,'UPDATE')).current_revision}}))).then(value=>({value}),error=>({error}))
  await waitForDatabaseLock(f,'business')
  await c.query('COMMIT')
  const result=await opening
  if(change==='revision'){assert.equal(result.error,undefined);assert.equal(result.value.file.revision,next)}
  else assert.equal(result.error?.statusCode,404)
  await assert.rejects(()=>f.files.openFile(f.bob.token,original.fileId),{statusCode:404})
 } finally {await c.query('ROLLBACK');c.release();await pool.end()}
})
