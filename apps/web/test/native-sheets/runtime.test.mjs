import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {buildSheetsGateway} from '../../server/sheets/build.mjs'
import {configuredSheetsRuntime} from '../../server/src/modules/sheets/runtime.ts'
const manifestPath=process.env.DYOFFICE_TEST_HOST_MANIFEST??new URL('../../../../.dyoffice-native-build/host-manifest.json',import.meta.url)
test('Sheets runtime verifies the native engine selected by the local server',async t=>{
 assert.equal(await configuredSheetsRuntime({}),undefined)
 await assert.rejects(()=>configuredSheetsRuntime({DYOFFICE_AUTH_MODE:'development'},{enabled:true}))
 await assert.rejects(()=>configuredSheetsRuntime({DYOFFICE_AUTH_MODE:'local',NODE_ENV:'production'},{enabled:true}))
 const manifest=JSON.parse(await readFile(manifestPath))
 const directory=await mkdtemp(join(tmpdir(),'dyoffice-sheets-runtime-'))
 t.after(()=>rm(directory,{recursive:true,force:true}))
 await buildSheetsGateway(join(directory,'gateway.mjs'))
 const env={DYOFFICE_AUTH_MODE:'local',DYOFFICE_DEPLOYMENT_ID:randomUUID(),DYOFFICE_NATIVE_BINARY:manifest.nativeBinary,DYOFFICE_NATIVE_SHA256:manifest.nativeSha256,DYOFFICE_XLSX_GATEWAY_RUNNER:join(directory,'gateway-process.mjs')}
 await assert.rejects(()=>configuredSheetsRuntime({...env,DYOFFICE_NATIVE_SHA256:'0'.repeat(64)},{enabled:true}))
 const hybrid={...env,DYOFFICE_XLSX_NODE_ENGINE:join(directory,'xlsx-node-engine.mjs')}
 await assert.rejects(()=>configuredSheetsRuntime({...hybrid,DYOFFICE_NATIVE_SHA256:'0'.repeat(64)},{enabled:true}))
 await assert.rejects(()=>configuredSheetsRuntime({...hybrid,DYOFFICE_NATIVE_SHA256:undefined},{enabled:true}),/configuration missing/)
 const runtime=await configuredSheetsRuntime(env,{enabled:true});t.after(()=>runtime.close())
 const bytes=await readFile(new URL('../fixtures/sheets/acceptance.xlsx',import.meta.url))
 assert.equal((await runtime.sheetsNative.inspect(bytes)).sheets[0].name,'Acceptance')
 assert.equal(typeof runtime.sheetsPlanner,'function')
 assert.equal((await runtime.sheetsPackageReader(bytes)).redactions.status,'absent')
 await runtime.close()
 await assert.rejects(()=>runtime.sheetsNative.inspect(bytes))
})

const runtimeModes=['rust','hybrid']
if(process.env.DYOFFICE_TEST_XLSX_WASI_REFRESH_RUNNER)runtimeModes.push('wasi')
// The deadline includes database setup, import and sandbox startup.
for(const mode of runtimeModes)test(`actual ${mode} server entry enables owned Sheets API and shuts down cleanly`,{timeout:45000},async t=>{
 const {spawn}=await import('node:child_process'),{once}=await import('node:events'),{fileURLToPath}=await import('node:url')
 const {fileFixture,importFile}=await import('../helpers/files.mjs')
 const {createCsrfService}=await import('../../server/src/modules/auth/csrf.ts')
 const f=await fileFixture(t),origin='https://office.example'
 const bytes=await readFile(new URL('../fixtures/sheets/acceptance.xlsx',import.meta.url))
 const file=(await importFile(f,f.alice.token,bytes,'acceptance.xlsx')).file
 const manifest=mode==='wasi'?null:JSON.parse(await readFile(manifestPath))
 const env={...process.env,NODE_ENV:'development',DYOFFICE_AUTH_MODE:'local',DYOFFICE_NATIVE_JOBS:'',DYOFFICE_DATABASE_URL:'',DYOFFICE_USER_TOKEN:'',DYOFFICE_ADMIN_TOKEN:'',DYOFFICE_AUTH_DATABASE_URL:f.urls.auth,DYOFFICE_BUSINESS_DATABASE_URL:f.urls.business,DYOFFICE_DEPLOYMENT_ID:f.deploymentId,DYOFFICE_ORIGIN:origin,DYOFFICE_CSRF_KEY:f.csrfKey,DYOFFICE_NATIVE_BINARY:manifest?.nativeBinary??'',DYOFFICE_NATIVE_SHA256:manifest?.nativeSha256??'',DYOFFICE_FILE_API:'experimental',DYOFFICE_OBJECT_STORE:'local-dev',DYOFFICE_OBJECT_DIRECTORY:f.directory,PORT:'0',HOST:'127.0.0.1'}
 env.DYOFFICE_XLSX_NODE_ENGINE=mode==='hybrid'?fileURLToPath(new URL('../../dist-sheets-server/xlsx-node-engine.mjs',import.meta.url)):''
 delete env.DYOFFICE_XLSX_WASI_REFRESH_RUNNER
 const child=spawn(process.execPath,['--experimental-transform-types','--import','tsx','server/index.mjs'],{cwd:fileURLToPath(new URL('../../',import.meta.url)),env,stdio:['ignore','pipe','pipe']})
 f.cleanup.push(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await once(child,'exit')}})
 const exited=once(child,'exit')
 const [output]=await Promise.race([once(child.stdout,'data'),exited.then(()=>{throw new Error('Sheets entry failed to start')})])
 const address=String(output).match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];assert.ok(address)
 const csrf=createCsrfService({db:f.db,deploymentId:f.deploymentId,origin,key:f.csrfKey})
 const headers={cookie:'__Host-dyoffice-session='+f.alice.token,origin,'x-csrf-token':csrf.sessionToken(f.alice.token),'content-type':'application/json'}
 const capabilities=await fetch(address+'/api/v1/capabilities',{headers});assert.equal((await capabilities.json()).xlsx,'editable')
 const result=await fetch(address+'/api/v1/files/'+file.fileId+'/sheets/inspect',{method:'POST',headers,body:JSON.stringify({revision:file.revision})})
 assert.equal(result.status,200);assert.equal((await result.json()).sheets[0].name,'Acceptance')
 const links=await fetch(address+'/api/v1/files/'+file.fileId+'/sheets/external-links',{method:'POST',headers,body:JSON.stringify({revision:file.revision})})
 assert.equal(links.status,200)
 assert.deepEqual(await links.json(),{links:[],workspaceSources:true})
 const entry=await fetch(address+'/native-xlsx/?fileId='+file.fileId,{headers});assert.equal(entry.status,200)
 child.kill('SIGTERM');assert.deepEqual(await exited,[0,null])
})
