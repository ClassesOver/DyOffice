import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile,mkdtemp,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createHash,randomUUID} from 'node:crypto'
import {buildSheetsGateway} from '../../server/sheets/build.mjs'
import {createHostProcess} from '../../worker/src/sandbox/host-process.ts'
import {createGatewayAdapter} from '../../worker/src/native/gateway.ts'
import {createXlsxNativeWorker} from '../../worker/src/native/xlsx.ts'
import {sandboxFixture} from '../helpers/native-sandbox.mjs'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {s3Fixture} from '../helpers/s3.mjs'
import {sheetsSaveRequest} from '../helpers/sheets-request.mjs'
import {createLeaseService} from '../../server/src/modules/leases/service.ts'
import {createCsrfService} from '../../server/src/modules/auth/csrf.ts'
import {restrictedOrigin} from '../helpers/restricted.mjs'

const digest=bytes=>createHash('sha256').update(bytes).digest('hex')
const median=values=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)]
test('P0 real isolated native XLSX complete prepare and commit measurements', {skip:process.env.DYOFFICE_RUN_NATIVE_SAVE_BENCHMARK!=='synthetic-local-only',timeout:180000},async t=>{
  assert.equal(process.getuid(),0,'Real systemd host sandbox requires authorized root execution')
  const db=new URL(process.env.DYOFFICE_TEST_DATABASE_URL)
  assert.ok(['localhost','127.0.0.1'].includes(db.hostname));assert.equal(db.port,'55433');assert.equal(db.pathname,'/dyoffice_test')
  const directory=await mkdtemp(join(tmpdir(),'dyoffice-save-benchmark-'));t.after(()=>rm(directory,{recursive:true,force:true}))
  await buildSheetsGateway(join(directory,'gateway.mjs'))
  let measurement
  const observed=(backend,kind)=>({async run(bytes,execute,options){
    const sample=measurement,start=performance.now()
    if(sample){sample.coldStartCount++;sample.coldStarts[kind]++}
    try{return await backend.run(bytes,io=>execute({...io,request(command,args){if(sample)sample.commands.push(kind+':'+command);return io.request(command,args)}}),options)}
    finally{if(sample)sample.nativeMs[kind]+=performance.now()-start}
  }})
  const native=createXlsxNativeWorker(observed(await sandboxFixture('native'),'rust'))
  const script=join(directory,'gateway-process.mjs')
  const gateway=createGatewayAdapter(observed(createHostProcess({binary:process.execPath,sha256:digest(await readFile(process.execPath)),deploymentId:randomUUID(),script:{path:script,sha256:digest(await readFile(script))},allowedCommands:['gateway_package','gateway_plan']}),'gateway'))
  const useWorkbookPlanner=process.env.DYOFFICE_NATIVE_SAVE_PLANNER==='workbook'
  if(useWorkbookPlanner)assert.equal(typeof gateway.planFromWorkbook,'function','Optimized method must exist; never silently benchmark fallback')
  const {store}=await s3Fixture(t)
  const f=await fileFixture(t,{objectStore:store,sheetsNative:native,sheetsPlanner:(bytes,sheets,request,signal)=>gateway.planWorkbookSave(bytes,sheets.map(({id,name})=>({id,name})),request,signal),sheetsWorkbookPlanner:useWorkbookPlanner?gateway.planFromWorkbook:undefined})
  const instrumented=new WeakSet()
  for(const [role,pool] of [['auth',f.authPool],['business',f.businessPool],['owner',f.ownerPool]])pool.on('acquire',client=>{
    if(instrumented.has(client))return;instrumented.add(client)
    const query=client.query
    client.query=function(...args){if(measurement){measurement.sqlCount++;measurement.sqlCounts[role]++}return query.apply(this,args)}
  })
  const bytes=await readFile(new URL('../fixtures/sheets/acceptance.xlsx',import.meta.url))
  const metadata=await native.inspect(bytes)
  const csrf=createCsrfService({db:f.db,deploymentId:f.deploymentId,origin:restrictedOrigin,key:f.csrfKey})
  const headers={cookie:'__Host-dyoffice-session='+f.alice.token,origin:restrictedOrigin,'x-csrf-token':csrf.sessionToken(f.alice.token)}
  const leases=createLeaseService({transactions:f.transactions}),samples=[]
  // No warmup is excluded: every native/gateway invocation is a cold process.
  for(let round=0;round<3;round++){
    const initial=(await importFile(f,f.alice.token,bytes,'acceptance.xlsx')).file
    const editorId=randomUUID(),lease=await leases.acquireLease(f.alice.token,initial.fileId,{editorId})
    measurement={round,coldStartCount:0,coldStarts:{rust:0,gateway:0},commands:[],nativeMs:{rust:0,gateway:0},sqlCount:0,sqlCounts:{auth:0,business:0,owner:0}}
    const sample=measurement,start=performance.now()
    const draft=await f.app.inject({method:'POST',url:`/api/v1/files/${initial.fileId}/sheets/uploads`,headers,payload:{baseRevision:initial.revision,leaseEpoch:lease.leaseEpoch,editorId,request:sheetsSaveRequest(metadata.sheets[0].id,[{row:1,column:0,writeValue:true,value:21.25}])}})
    sample.prepareMs=performance.now()-start;sample.prepareSql=sample.sqlCount
    if(draft.statusCode!==200)t.diagnostic(JSON.stringify({draftStatus:draft.statusCode,sample}))
    assert.equal(draft.statusCode,200,draft.body)
    assert.equal(sample.coldStartCount,useWorkbookPlanner?2:3,'stable prepare process count')
    const prepared=draft.json(),commitStart=performance.now()
    const saved=await f.app.inject({method:'POST',url:`/api/v1/files/${initial.fileId}/commits`,headers,payload:{fileId:initial.fileId,uploadId:prepared.uploadId,baseRevision:initial.revision,leaseEpoch:lease.leaseEpoch,idempotencyKey:randomUUID()}})
    sample.commitMs=performance.now()-commitStart;sample.prepareCommitMs=performance.now()-start
    assert.equal(saved.statusCode,200,saved.body)
    assert.equal(saved.json().sha256,prepared.sha256);assert.equal(saved.json().size,prepared.size)
    const reopenStart=performance.now()
    const reopened=await f.app.inject({method:'POST',url:`/api/v1/files/${initial.fileId}/sheets/inspect`,headers,payload:{revision:saved.json().revision}})
    sample.bridgeInspectMs=performance.now()-reopenStart;sample.withBridgeInspectMs=performance.now()-start
    assert.equal(reopened.statusCode,200,reopened.body);assert.equal(reopened.json().sheets[0].name,'Acceptance')
    measurement=undefined
    assert.equal(sample.coldStartCount,useWorkbookPlanner?3:4,'bridge inspect remains a real native launch')
    assert.equal(digest(await f.files.readFile(f.alice.token,initial.fileId,saved.json().revision)),prepared.sha256)
    assert.deepEqual(await f.files.readFile(f.alice.token,initial.fileId,initial.revision),bytes)
    samples.push(sample)
  }
  t.diagnostic('P0_NATIVE_SAVE_MEASUREMENTS '+JSON.stringify({label:process.env.DYOFFICE_P0_LABEL??'unspecified',planner:useWorkbookPlanner?'workbook':'legacy',node:process.version,fixtureSha256:digest(bytes),fixtureBytes:bytes.length,method:'Three sequential same-fixture HTTP inject prepare + T06 commit + bridge inspect; real root systemd Rust/Node gateway, loopback disposable PG/S3, no mocked timings or warmup exclusion. All SQL client statements including authority and transaction setup are counted; fixture/import/readback excluded. Local medians only, not production p95.',medianMs:Object.fromEntries(['prepareMs','commitMs','prepareCommitMs','bridgeInspectMs','withBridgeInspectMs'].map(key=>[key,median(samples.map(s=>s[key]))])),raw:samples}))
})
