import test from 'node:test'
import assert from 'node:assert/strict'
import { fileFixture, importFile, docxBytes } from '../helpers/files.mjs'
import { restrictedOrigin } from '../helpers/restricted.mjs'

test('42 files move atomically through the authenticated trash endpoint', async t => {
  const f = await fileFixture(t), bytes = await docxBytes(), ids = []
  for (let index = 0; index < 42; index++) {
    ids.push((await importFile(f, f.alice.token, bytes, index + '.docx')).file.fileId)
  }
  const other = (await importFile(f, f.bob.token, bytes)).file.fileId
  const cookie = '__Host-dyoffice-session=' + f.alice.token
  const proof = await f.app.inject({method:'GET',url:'/api/v1/auth/session-proof',headers:{cookie}})
  assert.equal(proof.statusCode, 200)
  const headers = {cookie, origin: restrictedOrigin, 'x-csrf-token':proof.json().csrfToken}
  const call = (selected, suffix = '') => f.app.inject({method:'POST',url:'/api/v1/files/trash-batch'+suffix,headers,payload:{ids:selected}})
  assert.equal((await call([...ids,other])).statusCode,404)
  assert.equal((await call(ids,'/status')).json().active.length,42)
  assert.equal((await call(ids)).statusCode,200)
  assert.deepEqual((await call(ids,'/status')).json(),{active:[]})
  assert.equal((await call(ids)).statusCode,200)
  assert.equal((await f.files.listFiles(f.alice.token,{trash:true,limit:100})).files.length,42)
  assert.equal((await f.files.listFiles(f.bob.token,{trash:false})).files.length,1)
})
