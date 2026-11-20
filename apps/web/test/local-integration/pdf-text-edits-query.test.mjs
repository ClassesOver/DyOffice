import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {PDFDocument} from 'pdf-lib'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {restrictedOrigin} from '../helpers/restricted.mjs'
import {createCsrfService,SESSION_COOKIE} from '../../server/src/modules/auth/csrf.ts'

test('PDF text validation distinguishes unmatched targets and cannot read or save another revision',async t=>{
 const f=await fileFixture(t),doc=await PDFDocument.create()
 doc.addPage([300,240]).drawText('Current line',{x:24,y:144,size:12})
 const original=Buffer.from(await doc.save())
 const {file}=await importFile(f,f.alice.token,original,'text-validation.pdf')
 const csrf=createCsrfService({db:f.db,deploymentId:f.deploymentId,origin:restrictedOrigin,key:f.csrfKey})
 const edit={pageIndex:0,rect:[24,140,90,157],oldText:'Current line',newText:'New line',fontSize:12}
 const input={revision:file.revision,edits:[edit,{...edit,oldText:'Missing text'}]}
 const query=(token,payload)=>f.app.inject({method:'POST',url:`/api/v1/files/${file.fileId}/pdf/text-edits/query`,payload,
  headers:{origin:restrictedOrigin,cookie:SESSION_COOKIE+'='+token,'x-csrf-token':csrf.sessionToken(token)}})
 assert.equal((await query(f.bob.token,input)).statusCode,404)
 assert.equal((await query(f.alice.token,{...input,revision:randomUUID()})).statusCode,409)
 assert.equal((await query(f.alice.token,{...input,edits:[{...edit,path:'/some-file'}]})).statusCode,400)
 const response=await query(f.alice.token,input)
 assert.equal(response.statusCode,200,response.body)
 const result=response.json()
 assert.equal(result.revision,file.revision)
 assert.equal(result.edits[0].reason,null)
 assert.ok(result.edits[0].bounds?.length===4)
 assert.equal(typeof result.edits[1].reason,'string')
 assert.equal(result.edits[1].bounds,undefined)
 assert.equal((await f.files.openFile(f.alice.token,file.fileId)).file.revision,file.revision)
 assert.deepEqual(await f.files.readFile(f.alice.token,file.fileId,file.revision),original)
})
