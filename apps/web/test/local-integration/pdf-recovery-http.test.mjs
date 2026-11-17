import {test} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import Fastify from 'fastify'
import {PDFDocument} from 'pdf-lib'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {createLeaseService} from '../../server/src/modules/leases/service.ts'
import {createRevisionService} from '../../server/src/modules/revisions/service.ts'
import {createPdfRotationJob} from '../../server/src/pdf/rotation-job.mjs'
import {createPdfSavePreparation} from '../../server/src/pdf/save-preparation.mjs'
import {createPdfReceiptRecovery} from '../../server/src/pdf/receipt-recovery.mjs'
import {registerPdfRecoveryRoutes} from '../../server/src/pdf/recovery-routes.mjs'
import {createCsrfService,SESSION_COOKIE} from '../../server/src/modules/auth/csrf.ts'
import {password} from '../helpers/identity.mjs'

const origin='https://office.example'
async function fixture(t){
 const f=await fileFixture(t,{buildApp:false}),doc=await PDFDocument.create();doc.addPage([200,100])
 const original=(await importFile(f,f.alice.token,Buffer.from(await doc.save()),'synthetic.pdf')).file
 const leases=createLeaseService({transactions:f.transactions}),revisions=createRevisionService({transactions:f.transactions,objects:f.objects,files:f.files})
 const editorId=randomUUID(),lease=await leases.acquireLease(f.alice.token,original.fileId,{editorId}),key=randomUUID()
 const prepared=await createPdfSavePreparation({files:f.files,leases,revisions,processor:createPdfRotationJob()}).prepare({token:f.alice.token,fileId:original.fileId,baseRevision:original.revision,editorId,leaseEpoch:lease.leaseEpoch,idempotencyKey:key,request:JSON.stringify({version:1,action:'rotatePages',operations:[{page:1,degrees:90}]})})
 const baseline=await counts(f)
 assert.equal(baseline.uploads,2);assert.equal(baseline.revisions,1);assert.equal(baseline.commits,0)
 const csrf=createCsrfService({db:f.db,deploymentId:f.deploymentId,origin,key:f.csrfKey})
 let lookups=0
 const start=async()=>{
  const app=Fastify({logger:false,ajv:{customOptions:{removeAdditional:false,coerceTypes:false}}})
  t.after(()=>app.close())
  registerPdfRecoveryRoutes(app,{sessions:f.sessions,csrf,createRequestRecovery:token=>({async lookup(...args){lookups++;return createPdfReceiptRecovery({transactions:f.transactions,token}).lookup(...args)}})})
  const address=await app.listen({host:'127.0.0.1',port:0})
  const post=async({token=f.alice.token,body={fileId:original.fileId,idempotencyKey:key},headers={},suffix=''}={})=>{
   const response=await fetch(address+'/api/v1/pdf-recovery/lookup'+suffix,{method:'POST',headers:{origin,cookie:`${SESSION_COOKIE}=${token}`,'x-csrf-token':csrf.sessionToken(token),'content-type':'application/json',...headers},body:JSON.stringify(body)})
   const text=await response.text();return {status:response.status,headers:response.headers,text,json:JSON.parse(text)}
  }
  return {app,address,post}
 }
 return {...f,original,key,prepared,revisions,start,get lookups(){return lookups}}
}
// FORCE RLS requires a current principal: an unscoped ownerPool can see zero rows.
const counts=async(f,token=f.alice.token)=>f.transactions.withPrincipalTransaction({kind:'session',token},async c=>(await c.query('SELECT (SELECT count(*) FROM uploads)::int uploads,(SELECT count(*) FROM file_revisions)::int revisions,(SELECT count(*) FROM revision_commits)::int commits')).rows[0])

test('loopback HTTP recovers a committed PDF receipt after server recreation without another save',async t=>{
 const f=await fixture(t),first=await f.start()
 assert.deepEqual((await first.post()).json,{state:'unresolved'})
 const saved=await f.revisions.commitRevision(f.alice.token,f.prepared.commitInput)
 await first.app.close()
 const second=await f.start(),before=await counts(f),result=await second.post()
 assert.equal(before.uploads,2);assert.equal(before.revisions,2);assert.equal(before.commits,1)
 assert.equal(result.status,200);assert.deepEqual(result.json,{state:'committed',revision:saved})
 assert.equal(result.headers.get('cache-control'),'private, no-store')
 assert.equal(result.headers.get('referrer-policy'),'no-referrer')
 assert.equal(result.text.includes(f.key),false);assert.equal(result.text.includes(f.alice.token),false)
 assert.deepEqual(await counts(f),before)
 const bytes=await f.files.readFile(f.alice.token,saved.fileId,saved.revision)
 assert.equal((await PDFDocument.load(bytes)).getPage(0).getRotation().angle,90)
})

test('origin CSRF malformed and broadened requests are rejected before a lookup',async t=>{
 const f=await fixture(t),server=await f.start(),before=await counts(f)
 for(const headers of [{origin:'https://evil.example'},{'x-csrf-token':'wrong'},{cookie:''}])assert.ok([401,403].includes((await server.post({headers})).status))
 for(const body of [{fileId:f.original.fileId,idempotencyKey:f.key,action:'rotatePages'},{fileId:f.original.fileId,idempotencyKey:'x'},{fileId:'bad',idempotencyKey:f.key}])assert.equal((await server.post({body})).status,400)
 assert.equal((await server.post({suffix:'?idempotencyKey='+f.key})).status,400)
 assert.equal(f.lookups,0);assert.deepEqual(await counts(f),before)
 const get=await fetch(server.address+'/api/v1/pdf-recovery/lookup');assert.equal(get.status,404)
})

test('cross-owner and revoked sessions cannot enumerate a receipt; fresh owner session is reauthorized',async t=>{
 const f=await fixture(t),saved=await f.revisions.commitRevision(f.alice.token,f.prepared.commitInput),server=await f.start(),before=await counts(f)
 for(const key of [f.key,randomUUID()])assert.equal((await server.post({token:f.bob.token,body:{fileId:f.original.fileId,idempotencyKey:key}})).status,404)
 assert.equal((await server.post({token:f.adminSigned.token})).status,404)
 await f.sessions.logout(f.alice.token);assert.equal((await server.post()).status,401)
 const fresh=await f.sessions.login('alice',password)
 assert.deepEqual((await server.post({token:fresh.token})).json,{state:'committed',revision:saved})
 assert.deepEqual(await counts(f,fresh.token),before)
})

test('unresolved is read-only and trash blocks historical receipt access',async t=>{
 const f=await fixture(t),server=await f.start(),before=await counts(f)
 assert.deepEqual((await server.post()).json,{state:'unresolved'})
 assert.deepEqual((await server.post({body:{fileId:f.original.fileId,idempotencyKey:randomUUID()}})).json,{state:'unresolved'})
 assert.deepEqual(await counts(f),before)
 assert.equal((await f.files.openFile(f.alice.token,f.original.fileId)).file.revision,f.original.revision)
 await f.revisions.commitRevision(f.alice.token,f.prepared.commitInput)
 await f.files.trashFile(f.alice.token,f.original.fileId)
 assert.equal((await server.post()).status,404)
})
