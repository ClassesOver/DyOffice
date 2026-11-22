import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {restrictedOrigin} from '../helpers/restricted.mjs'
import {createCsrfService,SESSION_COOKIE} from '../../server/src/modules/auth/csrf.ts'

test('PDF signature query verifies the pinned bytes without mutating or exposing the file',async t=>{
 const f=await fileFixture(t)
 const original=await readFile(new URL('../fixtures/signed-approval.pdf',import.meta.url))
 const tampered=Buffer.from(original)
 const reason='/Reason ('
 const reasonOffset=tampered.indexOf(reason)
 assert.ok(reasonOffset>=0)
 tampered[reasonOffset+reason.length]='X'.charCodeAt(0)
 const signed=(await importFile(f,f.alice.token,original,'signed.pdf')).file
 const edited=(await importFile(f,f.alice.token,tampered,'tampered.pdf')).file
 const csrf=createCsrfService({db:f.db,deploymentId:f.deploymentId,origin:restrictedOrigin,key:f.csrfKey})
 const query=(file,token=f.alice.token,payload={revision:file.revision},proof=csrf.sessionToken(token))=>f.app.inject({
  method:'POST',url:`/api/v1/files/${file.fileId}/pdf/signatures/query`,payload,
  headers:{origin:restrictedOrigin,cookie:SESSION_COOKIE+'='+token,'x-csrf-token':proof},
 })
 for(const token of [f.bob.token,f.adminSigned.token])assert.equal((await query(signed,token)).statusCode,404)
 assert.equal((await query(signed,f.alice.token,undefined,'invalid')).statusCode,403)
 assert.equal((await query(signed,f.alice.token,{revision:randomUUID()})).statusCode,409)
 const read=async file=>{
  const response=await query(file)
  assert.equal(response.statusCode,200,response.body)
  const report=response.json()
  assert.equal(report.revision,file.revision)
  assert.equal(report.signatures.length,1)
  assert.equal((await f.files.openFile(f.alice.token,file.fileId)).file.revision,file.revision)
  return report.signatures[0]
 }
 const intact=await read(signed)
 assert.equal(intact.signer.commonName,'DyOffice QA fixture')
 assert.equal(intact.status,'untrusted')
 assert.equal(intact.coversWholeDocument,true)
 assert.deepEqual(intact.problems,['self-signed'])
 const invalid=await read(edited)
 assert.equal(invalid.status,'invalid')
 assert.deepEqual(invalid.problems,['digest-mismatch'])
 assert.deepEqual(await f.files.readFile(f.alice.token,signed.fileId,signed.revision),original)
 assert.deepEqual(await f.files.readFile(f.alice.token,edited.fileId,edited.revision),tampered)
})
