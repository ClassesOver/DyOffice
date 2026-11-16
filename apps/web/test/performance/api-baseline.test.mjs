import test from 'node:test'
import assert from 'node:assert/strict'
import {performance} from 'node:perf_hooks'
import {cpus,totalmem,freemem,loadavg} from 'node:os'
import {readFile,mkdir,writeFile,rename} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {fileFixture,docxBytes,importFile} from '../helpers/files.mjs'
import {SESSION_COOKIE} from '../../server/src/modules/auth/csrf.ts'
import {runSamples,summarize,BASELINE_WORKLOAD as workload} from '../../../../tools/dyoffice/performance-samples.mjs'

// Not a production endpoint runner. Each fixture creates and later removes its own DB/roles.
if(process.env.GITHUB_ACTIONS!=='true'||process.env.DYOFFICE_RUN_PERFORMANCE_BASELINE!=='synthetic-ci-only')throw new Error('Explicit disposable CI performance opt-in required')
const optional=async path=>{try{return(await readFile(path,'utf8')).trim()}catch{return null}}
const sha=bytes=>createHash('sha256').update(bytes).digest('hex')

test('small authenticated API baseline records all outcomes without capacity claims',{timeout:180000},async t=>{
 const f=await fileFixture(t,{origin:'http://127.0.0.1',businessMax:4})
 const bytes=await docxBytes(),created=[]
 for(let i=0;i<10;i++)created.push(await importFile(f,f.alice.token,bytes,`synthetic-${i}.docx`))
 const first=created[0],fileId=first.file.fileId
 const address=await f.app.listen({port:0,host:'127.0.0.1'})
 const routes=[
  {label:'files-list-10',path:'/api/v1/files?limit=100',check:body=>Array.isArray(body.files)&&body.files.length===10},
  {label:'personal-preferences',path:'/api/v1/preferences',check:body=>typeof body.authorName==='string'},
  {label:'file-metadata',path:'/api/v1/files/'+fileId,check:body=>body.file?.fileId===fileId&&body.file?.size===bytes.length},
 ]
 assert.equal(routes.length,workload.routeCount)
 const request=route=>async()=>{
  const start=performance.now();let status=0
  try{
   const response=await fetch(address+route.path,{headers:{cookie:`${SESSION_COOKIE}=${f.alice.token}`},redirect:'error',signal:AbortSignal.timeout(5000)})
   status=response.status;const raw=await response.text(),durationMs=performance.now()-start
   let ok=false;try{ok=status===200&&route.check(JSON.parse(raw))}catch{}
   return{durationMs,status,ok,responseBytes:Buffer.byteLength(raw),...(ok?{}:{error:'unexpected-status-or-shape'})}
  }catch{return{durationMs:performance.now()-start,status,ok:false,error:'transport-or-timeout'}}
 }
 const before={cpu:process.cpuUsage(),rss:process.memoryUsage().rss,load:loadavg()}
 const report={schema:1,gitCommit:process.env.GITHUB_SHA,createdAt:new Date().toISOString(),
  scope:'Small synthetic closed-loop, client-observed loopback HTTP baseline; NOT server-side latency, capacity, cold-start or section 8 acceptance',
  environment:{node:process.version,platform:process.platform,arch:process.arch,cpuModel:cpus()[0]?.model,logicalCpus:cpus().length,totalMemoryBytes:totalmem(),freeMemoryBytes:freemem(),runnerImage:process.env.ImageVersion,cgroupCpuMax:await optional('/sys/fs/cgroup/cpu.max'),cgroupMemoryMax:await optional('/sys/fs/cgroup/memory.max')},
  provenance:{rootPackageLockSha256:sha(await readFile(new URL('../../../../package-lock.json',import.meta.url))),migrations:(await f.ownerPool.query('SELECT version,sha256 FROM identity_migrations ORDER BY version')).rows},
  fixture:{format:'docx',source:'packages/docx-engine/tests/fixtures/truths/render-sectafter-no-blank/probe.docx',sha256:sha(bytes),bytesPerFile:bytes.length,fileCount:10,authenticatedUsers:1,businessPoolMax:4,authPoolMax:6,storage:'isolated local-dev (read workload does not measure S3 throughput)'},
  method:{requestTimeoutMs:5000,measuredRequestsPerRouteRound:workload.samplesPerRouteRound,rounds:workload.rounds,concurrency:workload.concurrency,percentile:'nearest rank; 30-sample p99 equals max, not a stable tail estimate',loadModel:'closed-loop; no production arrival-rate model or coordinated-omission correction',timing:'client request initiation through full response body; excludes JSON oracle evaluation; client and server share one process'},
  firstObserved:[],warmup:[],rounds:[],remaining:{serverSideP95:'not_run: loopback timing is a different metric',hundredSessions25Editors10AIRuns4NativeTasks:'not_run: this measures one user read-only APIs',revisionCommit:'not_run',fourFormatOpening:'not_run',modelLatency:'blocked: no approved provider workload',revocationPropagation:'not_run',stability24h:'not_run',recoveryRpoRto:'not_run'}}
 const flush=async()=>{await mkdir('test-results',{recursive:true});await writeFile('test-results/performance-baseline.json.tmp',JSON.stringify(report,null,2)+'\n');await rename('test-results/performance-baseline.json.tmp','test-results/performance-baseline.json')}
 report.complete=false;await flush()
 const record=async(route,count,concurrency)=>{const start=performance.now(),samples=await runSamples({count,concurrency,request:request(route)});const elapsedMs=performance.now()-start;return{route:route.label,concurrency,elapsedMs,completedPerSecond:count*1000/elapsedMs,summary:summarize(samples),samples}}
 for(const route of routes){const first=await record(route,workload.firstPerRoute,1);report.firstObserved.push(first);await flush();assert.equal(first.summary.failed,0,'Initial route correctness failed; raw evidence retained')}
 for(const route of routes){report.warmup.push(await record(route,workload.warmupPerRoute,1));await flush()}
 for(let round=0;round<workload.rounds;round++)for(const concurrency of workload.concurrency)for(const route of [...routes.slice(round),...routes.slice(0,round)]){report.rounds.push({round:round+1,...await record(route,workload.samplesPerRouteRound,concurrency)});await flush()}
 const cpu=process.cpuUsage(before.cpu)
 report.resources={scope:'API plus HTTP client process; excludes PostgreSQL daemon; RSS high-water includes fixture setup',cpuUserMicroseconds:cpu.user,cpuSystemMicroseconds:cpu.system,rssBeforeBytes:before.rss,rssAfterBytes:process.memoryUsage().rss,processPeakRssKiB:process.resourceUsage().maxRSS,loadBefore:before.load,loadAfter:loadavg()}
 report.correctness={attempted:[...report.firstObserved,...report.warmup,...report.rounds].reduce((n,p)=>n+p.summary.attempted,0),failed:[...report.firstObserved,...report.warmup,...report.rounds].reduce((n,p)=>n+p.summary.failed,0)}
 report.complete=true;await flush()
 assert.equal(report.correctness.failed,0,'Every error is retained in the report; performance never excuses incorrect responses')
})
