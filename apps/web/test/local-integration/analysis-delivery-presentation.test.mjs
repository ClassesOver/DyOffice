// Real PostgreSQL/RLS, original session-proof service and bound browser client.
// All documents and analysis bytes are synthetic; no upstream network/model.
import test from 'node:test'
import assert from 'node:assert/strict'
import {randomBytes,randomUUID,createHash} from 'node:crypto'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import Fastify from 'fastify'
import {restrictedFixture} from '../helpers/restricted.mjs'
import {password} from '../helpers/identity.mjs'
import {createLocalObjectStore} from '../../server/src/storage/local-dev.ts'
import {createHarnessArtifacts} from '../../server/src/modules/coding/artifacts.ts'
import {registerAnalysisDeliveryRoutes} from '../../server/src/modules/coding/data-routes.ts'
import {createCsrfService,cookies} from '../../server/src/modules/auth/csrf.ts'
import {createSourceService} from '../../server/src/modules/sources/service.ts'
import {createWorkspaceSourceResults} from '../../server/src/modules/sources/results.ts'
import {createWorkspaceSourceTools} from '../../server/src/modules/sources/tools.ts'
import {createQuerySnapshot} from '../../server/src/modules/sources/provenance.ts'
import {createHarnessDataAccess} from '../../server/src/modules/coding/data-access.ts'
import {createAnalysisDeliveryClient} from '../../../../packages/browser-host/src/analysis-delivery-client.ts'
import {createLocalShellClient} from '../../src/shell/local-client.ts'
const hash=v=>createHash('sha256').update(v).digest('hex')
test('trusted presentation and attachment download fence real session changes, owner and revocation',async t=>{
 const f=await restrictedFixture(t,{buildApp:false,businessMax:4}),directory=await mkdtemp(join(tmpdir(),'delivery-ui-'));t.after(()=>rm(directory,{recursive:true,force:true}))
 const artifacts=createHarnessArtifacts({transactions:f.transactions,objects:await createLocalObjectStore({directory})})
 const sources=createSourceService({transactions:f.transactions,credentialKeys:'test:'+randomBytes(32).toString('base64')}),results=createWorkspaceSourceResults({transactions:f.transactions}),tools=createWorkspaceSourceTools({sources,results})
 await sources.create(f.alice.token,{sourceId:'metrics',name:'Metrics',kind:'http',config:{timezone:'UTC'},secret:'https://fixture.invalid/never-contacted'})
 const frozen=await results.capture(f.alice.token,createQuerySnapshot({sourceId:'metrics',sourceVersion:1,timezone:'Asia/Shanghai',schema:[{name:'n',type:'number',unit:'CNY'}],rows:[{n:1}],sourceTruncated:true}),hash('query'))
 const access=createHarnessDataAccess({tools,results,sessions:f.sessions,artifacts});t.after(()=>access.dispose())
 const grant=await access.issue({token:f.alice.token,agentId:'fixture',inputs:{sourceIds:[],resultIds:[frozen.resultId]},signal:new AbortController().signal})
 const execute=(op,args)=>access.execute(grant.taskId,grant.credential,op,args),bytes=Buffer.from('<svg onload="alert(1)">untrusted</svg>')
 const file=await execute('artifacts.stage',{name:'report.svg',mediaType:'image/svg+xml',role:'report',inputResultIds:[frozen.resultId],sha256:hash(bytes),bytesBase64:bytes.toString('base64')})
 const input=Object.fromEntries(['resultId','sha256','sourceId','sourceVersion','queryHash','rowCount','truncated'].map(k=>[k,frozen[k]]))
 const receipt=await execute('artifacts.commit',{commandId:randomUUID(),summary:'Untrusted conclusion',artifactIds:[file.artifactId],inputs:[input],runtimeManifestSha256:hash('runtime fixture'),limitations:['Truncated fixture']})
 assert.equal(receipt.inputs[0].timezone,'Asia/Shanghai');assert.deepEqual(receipt.inputs[0].schema,[{name:'n',type:'number',unit:'CNY'}])
 const app=Fastify();t.after(()=>app.close());const origin='https://office.example',csrf=createCsrfService({db:f.db,deploymentId:f.deploymentId,origin,key:f.csrfKey})
 registerAnalysisDeliveryRoutes(app,artifacts,csrf)
 app.get('/api/v1/auth/session-proof',async req=>{csrf.originCheck(req,false);const token=cookies(req).session;await f.sessions.authenticate(token);return {csrfToken:csrf.sessionToken(token)}})
 let token=f.alice.token
 const send=async(path,init={})=>{const result=await app.inject({method:init.method??'GET',url:path,headers:{...Object.fromEntries(new Headers(init.headers)),origin,cookie:'__Host-dyoffice-session='+token},...(init.body?{payload:init.body}:{})});return new Response(result.rawPayload,{status:result.statusCode,headers:result.headers})}
 const shell=createLocalShellClient(send),bound=await shell.bindSession(),client=createAnalysisDeliveryClient({request:bound.request,csrfToken:bound.proof,fetchImpl:send});t.after(()=>{client.dispose();shell.invalidateSession()})
 const hint={taskId:receipt.taskId,commandId:receipt.commandId,summary:'adapter lies'},agent={id:'fixture',name:'External fixture',origin:'external'}
 await client.observe(hint,agent);assert.equal(client.snapshot()[0].receipt.summary,'Untrusted conclusion');assert.equal(client.snapshot()[0].receipt.inputs[0].truncated,true)
 assert.equal(client.snapshot()[0].receipt.inputs[0].timezone,'Asia/Shanghai');assert.equal(client.snapshot()[0].receipt.inputs[0].schema[0].unit,'CNY')
 const downloaded=await client.download(receipt.commandId,file.artifactId);assert.deepEqual(Buffer.from(downloaded.bytes),bytes)
 const recovered=createAnalysisDeliveryClient({request:bound.request,csrfToken:bound.proof,fetchImpl:send});t.after(()=>recovered.dispose())
 await recovered.restore()
 assert.deepEqual(recovered.snapshot(),[{receipt}])
 const history='/api/v1/agents/deliveries'
 assert.equal((await send(history)).status,403)
 token=f.bob.token
 const bobBound=await createLocalShellClient(send).bindSession()
 assert.deepEqual(await bobBound.request(history),{deliveries:[]})
 await recovered.restore();assert.deepEqual(recovered.snapshot(),[])
 token=f.bob.token;await assert.rejects(client.download(receipt.commandId,file.artifactId));assert.equal(client.snapshot().length,0)
 const sameOwner=await f.sessions.login('alice',password);token=sameOwner.token
 await client.observe(hint,agent);assert.equal(client.snapshot().length,0,'Old proof cannot read even a replacement login for the same owner')
 const url='/api/v1/agents/artifacts/'+file.artifactId+'/content'
 for(const stale of ['',bound.proof])assert.equal((await send(url,{headers:{'X-CSRF-Token':stale}})).status,403)
 // Headerless old attachment navigation remains authenticated and inert.
 assert.equal((await send(url)).status,200)
 await f.sessions.logout(sameOwner.token);assert.notEqual((await send(url)).status,200)
 token=f.alice.token;await client.observe(hint,agent);assert.equal(client.snapshot().length,1)
 await f.sessions.logout(token);await assert.rejects(client.download(receipt.commandId,file.artifactId));assert.equal(client.snapshot().length,0)
})
