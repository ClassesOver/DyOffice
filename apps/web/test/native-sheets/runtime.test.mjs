import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import {buildSheetsGateway} from '../../server/sheets/build.mjs'
import {configuredSheetsRuntime} from '../../server/src/modules/sheets/runtime.ts'
test('Sheets runtime requires explicit experimental local configuration and real verified native startup',async t=>{
 assert.equal(await configuredSheetsRuntime({}),undefined)
 await assert.rejects(()=>configuredSheetsRuntime({DYOFFICE_NATIVE_XLSX:'true',DYOFFICE_AUTH_MODE:'local'}))
 await assert.rejects(()=>configuredSheetsRuntime({DYOFFICE_NATIVE_XLSX:'experimental',DYOFFICE_AUTH_MODE:'development'}))
 await assert.rejects(()=>configuredSheetsRuntime({DYOFFICE_NATIVE_XLSX:'experimental',DYOFFICE_AUTH_MODE:'local',NODE_ENV:'production'}))
 const manifest=JSON.parse(await readFile(new URL('../../../../.dyoffice-native-build/host-manifest.json',import.meta.url)))
 await buildSheetsGateway()
 const env={DYOFFICE_AUTH_MODE:'local',DYOFFICE_NATIVE_XLSX:'experimental',DYOFFICE_DEPLOYMENT_ID:randomUUID(),DYOFFICE_NATIVE_BINARY:manifest.nativeBinary,DYOFFICE_NATIVE_SHA256:manifest.nativeSha256}
 await assert.rejects(()=>configuredSheetsRuntime({...env,DYOFFICE_NATIVE_SHA256:'0'.repeat(64)}))
 const runtime=await configuredSheetsRuntime(env);t.after(()=>runtime.close())
 const bytes=await readFile(new URL('../fixtures/sheets/acceptance.xlsx',import.meta.url))
 assert.equal((await runtime.sheetsNative.inspect(bytes)).sheets[0].name,'Acceptance')
 assert.equal(typeof runtime.sheetsPlanner,'function')
 assert.equal((await runtime.sheetsPackageReader(bytes)).redactions.status,'absent')
 await runtime.close()
 await assert.rejects(()=>runtime.sheetsNative.inspect(bytes))
})

test('actual server entry enables owned Sheets API and shuts down cleanly',{timeout:20000},async t=>{
 const {spawn}=await import('node:child_process'),{once}=await import('node:events'),{fileURLToPath}=await import('node:url')
 const {fileFixture,importFile}=await import('../helpers/files.mjs')
 const {createCsrfService}=await import('../../server/src/modules/auth/csrf.ts')
 const f=await fileFixture(t),origin='https://office.example'
 const bytes=await readFile(new URL('../fixtures/sheets/acceptance.xlsx',import.meta.url))
 const file=(await importFile(f,f.alice.token,bytes,'acceptance.xlsx')).file
 const manifest=JSON.parse(await readFile(new URL('../../../../.dyoffice-native-build/host-manifest.json',import.meta.url)))
 const env={...process.env,NODE_ENV:'development',DYOFFICE_AUTH_MODE:'local',DYOFFICE_NATIVE_XLSX:'experimental',DYOFFICE_NATIVE_JOBS:'',DYOFFICE_NATIVE_DOCX:'',DYOFFICE_DATABASE_URL:'',DYOFFICE_USER_TOKEN:'',DYOFFICE_ADMIN_TOKEN:'',DYOFFICE_AUTH_DATABASE_URL:f.urls.auth,DYOFFICE_BUSINESS_DATABASE_URL:f.urls.business,DYOFFICE_DEPLOYMENT_ID:f.deploymentId,DYOFFICE_ORIGIN:origin,DYOFFICE_CSRF_KEY:f.csrfKey,DYOFFICE_NATIVE_BINARY:manifest.nativeBinary,DYOFFICE_NATIVE_SHA256:manifest.nativeSha256,DYOFFICE_FILE_API:'experimental',DYOFFICE_OBJECT_STORE:'local-dev',DYOFFICE_OBJECT_DIRECTORY:f.directory,PORT:'0',HOST:'127.0.0.1'}
 const child=spawn(process.execPath,['--experimental-strip-types','server/index.mjs'],{cwd:fileURLToPath(new URL('../../',import.meta.url)),env,stdio:['ignore','pipe','pipe']})
 f.cleanup.push(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await once(child,'exit')}})
 const exited=once(child,'exit')
 const [output]=await Promise.race([once(child.stdout,'data'),exited.then(()=>{throw new Error('Sheets entry failed to start')})])
 const address=String(output).match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];assert.ok(address)
 const csrf=createCsrfService({db:f.db,deploymentId:f.deploymentId,origin,key:f.csrfKey})
 const headers={cookie:'__Host-dyoffice-session='+f.alice.token,origin,'x-csrf-token':csrf.sessionToken(f.alice.token),'content-type':'application/json'}
 const capabilities=await fetch(address+'/api/v1/capabilities',{headers});assert.equal((await capabilities.json()).xlsx,'editable')
 const result=await fetch(address+'/api/v1/files/'+file.fileId+'/sheets/inspect',{method:'POST',headers,body:JSON.stringify({revision:file.revision})})
 assert.equal(result.status,200);assert.equal((await result.json()).sheets[0].name,'Acceptance')
 const entry=await fetch(address+'/native-xlsx/?fileId='+file.fileId,{headers});assert.equal(entry.status,200)
 child.kill('SIGTERM');assert.deepEqual(await exited,[0,null])
})
