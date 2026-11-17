import {test} from 'node:test'
import assert from 'node:assert/strict'
import {fileFixture,docxBytes,importFile} from '../helpers/files.mjs'
import {createWorkspaceService} from '../../server/src/modules/workspace/service.ts'

const url='/api/v1/workspace/files'
const get=(f,query='',token=f.alice.token)=>f.app.inject({method:'GET',url:url+query,headers:{cookie:'__Host-dyoffice-session='+token}})
test('bounded server-side literal filtering, counts and id lookup preserve tenant scope',async t=>{
 const f=await fileFixture(t),bytes=await docxBytes()
 const a=(await importFile(f,f.alice.token,bytes,'Budget%_2026.docx')).file.fileId
 await importFile(f,f.alice.token,bytes,'Other.docx')
 const foreign=(await importFile(f,f.bob.token,bytes,'Budget%_2026.docx')).file.fileId
 const filtered=await get(f,'?q='+encodeURIComponent('%_')+'&ext=docx&limit=1')
 assert.equal(filtered.statusCode,200,filtered.body)
 assert.equal(filtered.json().total,1);assert.equal(filtered.json().totalAll,2)
 assert.deepEqual(filtered.json().files.map(x=>x.id),[a])
 const count=await get(f,'?q=budget&limit=0')
 assert.equal(count.statusCode,200,count.body);assert.deepEqual(count.json(),{files:[],total:1,totalAll:2})
 assert.equal((await get(f,'?id='+a)).json().totalAll,1)
 assert.deepEqual((await get(f,'?id='+a)).json().files.map(x=>x.id),[a])
 assert.equal((await get(f,'?q='+encodeURIComponent('😀'.repeat(200)))).statusCode,200)
 assert.equal((await get(f,'?q='+encodeURIComponent('😀'.repeat(201)))).statusCode,400)
 assert.deepEqual((await get(f,'?id='+foreign)).json(),{files:[],total:0,totalAll:0})
 assert.deepEqual((await get(f,'?ext=pdf')).json(),{files:[],total:0,totalAll:2})
 assert.deepEqual((await get(f,'?q=budget&offset=1&limit=1')).json(),{files:[],total:1,totalAll:2})
 for(const query of ['?q='+encodeURIComponent('x'.repeat(201)),'?ext=exe','?id=not-uuid','?limit=-1','?limit=101'])assert.equal((await get(f,query)).statusCode,400,query)
 const service=createWorkspaceService(f.transactions)
 for(const options of [{q:'x'.repeat(201)},{q:5},{ext:'exe'},{id:foreign+'x'},{limit:-1}])await assert.rejects(service.listFiles(f.alice.token,options))
})

test('direct identity plan filters files before materialization and equal timestamps use id order',async t=>{
 const f=await fileFixture(t), bytes=await docxBytes()
 const ids=[]
 for(const name of ['a.docx','b.docx','c.docx'])ids.push((await importFile(f,f.alice.token,bytes,name)).file.fileId)
 await f.ownerPool.query("UPDATE files SET updated_at='2026-01-01' WHERE owner_id=$1",[f.alice.user.id])
 const page=(await get(f,'?limit=2')).json()
 assert.deepEqual(page.files.map(x=>x.id),[...ids].sort().slice(0,2))
 assert.deepEqual((await get(f,'?limit=2&offset=2')).json().files.map(x=>x.id),[...ids].sort().slice(2))
 let plan
 const wrapped={withPrincipalTransaction:(credential,work)=>f.transactions.withPrincipalTransaction(credential,async(connection,...args)=>{
  const query=connection.query.bind(connection)
  const proxy=new Proxy(connection,{get(target,key){if(key!=='query')return Reflect.get(target,key);return async(sql,params)=>{
   if(typeof sql==='string'&&sql.includes('WITH scoped AS MATERIALIZED')){
    assert.match(sql,/AND f\.id=\$10::uuid/)
    plan=(await query('EXPLAIN (ANALYZE, FORMAT JSON) '+sql,params)).rows[0]['QUERY PLAN'][0]
   }
   return query(sql,params)
  }}})
  return work(proxy,...args)
 })}
 await createWorkspaceService(wrapped).listFiles(f.alice.token,{id:ids[0],limit:1})
 assert.ok(plan)
 const nodes=[];function walk(n){nodes.push(n);for(const child of n.Plans??[])walk(child)}walk(plan.Plan)
 const files=nodes.filter(n=>n['Relation Name']==='files')
 console.log('identity files plan',JSON.stringify(files.map(n=>({type:n['Node Type'],index:n['Index Cond'],filter:n.Filter,rows:n['Actual Rows']}))))
 assert.ok(files.length)
 assert.ok(files.every(n=>n['Actual Rows']<=1))
 assert.ok(files.some(n=>String(n['Index Cond']??n.Filter).includes(ids[0])))
 // A second deployment in the SAME database exercises deployment scope, not database separation.
 const {randomUUID}=await import('node:crypto')
 const {createAccountService}=await import('../../server/src/modules/auth/service.ts')
 const {createSessionService}=await import('../../server/src/modules/auth/sessions.ts')
 const {createPrincipalTransactions}=await import('../../server/src/db/context.ts')
 const {createFileService}=await import('../../server/src/modules/files/service.ts')
 const {password}=await import('../helpers/identity.mjs')
 const deploymentId=randomUUID()
 const accounts=createAccountService({db:f.ownerDb,passwords:f.passwords,deploymentId})
 await accounts.bootstrapAdmin({username:'foreign',password})
 const sessions=createSessionService({db:f.ownerDb,accounts,deploymentId})
 const signed=await sessions.login('foreign',password)
 const transactions=createPrincipalTransactions({pool:f.businessPool,deploymentId})
 const filesService=createFileService({transactions,objects:f.objects})
 const foreign=(await importFile({files:filesService},signed.token,bytes,'foreign.docx')).file.fileId
 assert.deepEqual((await get(f,'?id='+foreign)).json(),{files:[],total:0,totalAll:0})
})
