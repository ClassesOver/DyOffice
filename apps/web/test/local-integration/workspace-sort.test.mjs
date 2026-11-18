import {test} from 'node:test'
import assert from 'node:assert/strict'
import {fileFixture,docxBytes,importFile} from '../helpers/files.mjs'
import {createWorkspaceService} from '../../server/src/modules/workspace/service.ts'

const ids=page=>page.files.map(file=>file.id)
const own=(f,sql,params)=>f.transactions.withPrincipalTransaction({kind:'session',token:f.alice.token},connection=>connection.query(sql,params))
const request=(f,query={},token=f.alice.token)=>f.app.inject({method:'GET',url:'/api/v1/workspace/files?'+new URLSearchParams(query),headers:{cookie:'__Host-dyoffice-session='+token}})
async function list(f,query={},token=f.alice.token){
 const response=await request(f,query,token)
 assert.equal(response.statusCode,200,response.body)
 return response.json()
}

test('modified sort pages all 55 recent files by edit time rather than inverse opening time, with stable ties and scoped counts',async t=>{
 const f=await fileFixture(t),bytes=await docxBytes(),workspace=createWorkspaceService(f.transactions),files=[]
 for(let i=0;i<55;i++){
  const id=(await importFile(f,f.alice.token,bytes,`${i<52?'Budget':'Other'} ${i}.docx`)).file.fileId
  files.push(id);await workspace.recordOpen(f.alice.token,id)
 }
 // 前三个文件使用相同修改时间；打开时间顺序刻意与修改时间相反。
 await own(f,`UPDATE files f SET updated_at=timestamp '2026-01-01'+greatest(v.position-3,0)*interval '1 hour'
  FROM unnest($1::uuid[]) WITH ORDINALITY v(id,position) WHERE f.id=v.id`,[files])
 await own(f,`UPDATE workspace_file_state s SET last_opened_at=timestamp '2026-02-01'+(56-v.position)*interval '1 hour'
  FROM unnest($1::uuid[]) WITH ORDINALITY v(id,position) WHERE s.file_id=v.id`,[files])
 const tie=[...files.slice(0,3)].sort(),ascending=[...tie,...files.slice(3)],descending=[...files.slice(3).reverse(),...tie]
 assert.deepEqual(ids(await list(f,{view:'recent',limit:100})),files,'default recent order remains opening time')
 assert.deepEqual(ids(await list(f,{view:'all',limit:100})),descending,'default all order remains edit time descending')
 for(const [sort,expected] of [['modified-asc',ascending],['modified-desc',descending]]){
  for(const view of ['all','recent']){
   const first=await list(f,{view,sort,limit:50}),last=await list(f,{view,sort,limit:50,offset:50})
   assert.deepEqual(ids(first),expected.slice(0,50),`${view}/${sort} first page`)
   assert.deepEqual(ids(last),expected.slice(50),`${view}/${sort} final page`)
   assert.equal(first.total,55);assert.equal(first.totalAll,55);assert.equal(last.total,55)
   assert.deepEqual(ids(await workspace.listFiles(f.alice.token,{view,sort,limit:100})),expected,'direct service and HTTP agree')
   assert.deepEqual(await list(f,{view,sort,limit:50,offset:55}),{files:[],total:55,totalAll:55})
  }
 }
 const folder=await workspace.createFolder(f.alice.token,{name:'Budget folder',parentId:null})
 await own(f,'UPDATE workspace_file_state SET folder_id=$1,starred=true WHERE file_id=ANY($2::uuid[])',[folder.id,files.slice(0,52)])
 const foreign=(await importFile(f,f.bob.token,bytes,'Budget foreign.docx')).file.fileId
 await workspace.recordOpen(f.bob.token,foreign)
 for(const [sort,expected] of [['modified-asc',ascending],['modified-desc',descending]]){
  const filtered=expected.filter(id=>files.slice(0,52).includes(id))
  const query={view:'recent',sort,folderId:folder.id,q:'Budget',ext:'docx',limit:50}
  assert.deepEqual(ids(await list(f,query)),filtered.slice(0,50))
  const last=await list(f,{...query,offset:50});assert.deepEqual(ids(last),filtered.slice(50));assert.equal(last.total,52);assert.equal(last.totalAll,52)
  assert.deepEqual(await list(f,{...query,limit:0}),{files:[],total:52,totalAll:52})
  assert.deepEqual(ids(await list(f,{view:'starred',sort,limit:100})),filtered)
  assert.deepEqual(ids(await list(f,{view:'recent',sort,folderId:'root',limit:100})),expected.filter(id=>files.slice(52).includes(id)))
  assert.deepEqual(await list(f,{sort,id:foreign}),{files:[],total:0,totalAll:0})
  assert.deepEqual(await list(f,{sort,q:'Budget',ext:'pdf'}),{files:[],total:0,totalAll:55})
  assert.equal((await list(f,{sort,q:'Budget',limit:0})).total,52)
 }
})

test('explicit modified sorting preserves trash membership and default trash ordering',async t=>{
 const f=await fileFixture(t),bytes=await docxBytes(),workspace=createWorkspaceService(f.transactions)
 const older=(await importFile(f,f.alice.token,bytes,'Old trash.docx')).file.fileId
 const newer=(await importFile(f,f.alice.token,bytes,'New trash.docx')).file.fileId
 await importFile(f,f.alice.token,bytes,'Still active.docx')
 await f.files.trashFile(f.alice.token,older);await f.files.trashFile(f.alice.token,newer)
 await own(f,"UPDATE files SET updated_at=CASE WHEN id=$1 THEN timestamp '2026-01-01' ELSE timestamp '2026-01-02' END WHERE id=ANY($2::uuid[])",[older,[older,newer]])
 assert.deepEqual(ids(await list(f,{view:'trash'})),[newer,older])
 assert.deepEqual(ids(await list(f,{view:'trash',sort:'modified-asc'})),[older,newer])
 assert.deepEqual(ids(await list(f,{view:'trash',sort:'modified-desc'})),[newer,older])
 assert.deepEqual(ids(await workspace.listFiles(f.alice.token,{view:'trash',sort:'modified-asc',limit:1,offset:1})),[newer])
})

test('HTTP and direct workspace callers reject every unsupported sort value',async t=>{
 const f=await fileFixture(t),workspace=createWorkspaceService(f.transactions)
 for(const sort of ['', 'oldest','MODIFIED-ASC','modified-asc ', 'updated_at ASC,id', 'modified-desc;SELECT 1'])assert.equal((await request(f,{sort})).statusCode,400,sort)
 for(const sort of [null,false,1,[],{},'oldest','updated_at ASC,id'])await assert.rejects(workspace.listFiles(f.alice.token,{sort}),error=>error.status===400||error.statusCode===400,JSON.stringify(sort))
 for(const sort of ['modified-asc','modified-desc'])assert.deepEqual(await list(f,{sort}),{files:[],total:0,totalAll:0})
})
