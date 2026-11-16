import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile,rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { execFile,spawn } from 'node:child_process'
import { promisify } from 'node:util'
const exec=promisify(execFile)
async function fixture(kind='probe',limits={}) {
  const { createHostProcess }=await import('../../worker/src/sandbox/host-process.ts')
  const meta=JSON.parse(await readFile(process.env.DYOFFICE_TEST_HOST_MANIFEST,'utf8'))
  const deploymentId=randomUUID()
  const runner=createHostProcess({ deploymentId,binary: kind==='native' ? meta.nativeBinary : meta.probeBinary,sha256: kind==='native' ? meta.nativeSha256 : meta.probeSha256,allowedCommands: kind==='native' ? ['open','close','save_archive','read_range','recalc_cells'] : ['probe','network','pids','sleep','busy','allocate','flood','output','symlink','park'],limits })
  return { runner,deploymentId }
}
async function empty(scope) {
  const text=(await exec('/usr/bin/systemctl',['list-units','--all','--no-legend','--no-pager','dyoffice-'+scope+'-*.service'])).stdout
  assert.equal(text.trim(),'')
}
test('host Rust process has a private filesystem, dynamic nonroot identity, no capabilities and no controller secrets',{ timeout: 20_000 },async () => {
  const { runner,deploymentId }=await fixture()
  process.env.DYOFFICE_TEST_CANARY='private-controller-only'
  try {
    const status=await runner.run(Buffer.from('input'),session => session.request('probe',{}))
    assert.ok(status.uid>0); assert.equal(status.gid,status.uid)
    assert.equal(status.capEff,'0000000000000000'); assert.equal(status.noNewPrivs,1)
    assert.equal(status.secretPresent,false); assert.equal(status.rootWritable,false); assert.equal(status.inputReadable,true)
    await empty(deploymentId)
  } finally { delete process.env.DYOFFICE_TEST_CANARY }
})
test('host output is a bounded regular file and original Rust opens and saves actual XLSX without Docker',{ timeout: 25_000 },async () => {
  const probe=await fixture()
  const bytes=await probe.runner.run(Buffer.from('input'),async session => { await session.request('output',{}); return session.readOutput() })
  assert.deepEqual(bytes,Buffer.from('native-output')); await empty(probe.deploymentId)
  await assert.rejects(() => probe.runner.run(Buffer.from('input'),async session => { await session.request('symlink',{}); return session.readOutput() }),{ code: 'INVALID_OUTPUT' })
  const native=await fixture('native'),{createXlsxNativeWorker}=await import('../../worker/src/native/xlsx.ts')
  const input=await readFile(new URL('../../../shell/build/shell-new/blank.xlsx',import.meta.url))
  const result=await createXlsxNativeWorker(native.runner).roundtrip(input)
  assert.equal(result.sheetCount,1); assert.ok(result.bytes.length>0); await empty(native.deploymentId)
})
test('host process network and process-count isolation are kernel enforced',{ timeout: 20_000 },async()=>{
  const f=await fixture('probe',{pids:16})
  await f.runner.run(Buffer.from('input'),async session=>{
    const net=await session.request('network',{port:3080});assert.equal(net.connected,false)
    const pids=await session.request('pids',{});assert.equal(pids.limited,true);assert.ok(pids.forked>0&&pids.forked<16)
  });await empty(f.deploymentId)
})
test('host CPU, memory and wall limits terminate the service without killing the controller',{timeout:30000},async()=>{
  const cpu=await fixture('probe',{cpuSeconds:1,wallMs:10000})
  await assert.rejects(()=>cpu.runner.run(Buffer.from('input'),s=>s.request('busy',{})),{code:'RESOURCE_LIMIT'})
  await empty(cpu.deploymentId)
  const memory=await fixture('probe',{memoryMiB:64,wallMs:10000})
  await assert.rejects(()=>memory.runner.run(Buffer.from('input'),s=>s.request('allocate',{})),e=>{assert.equal(e.code,'RESOURCE_LIMIT');assert.equal(e.oomKilled,true);return true})
  await empty(memory.deploymentId)
  const wall=await fixture('probe',{wallMs:1000})
  await assert.rejects(()=>wall.runner.run(Buffer.from('input'),s=>s.request('sleep',{})),{code:'SANDBOX_TIMEOUT'})
  await empty(wall.deploymentId)
})
test('host cancellation, protocol flood and cancelled preparation leave no active native service',{timeout:20000},async()=>{
  const f=await fixture(),stop=new AbortController()
  await assert.rejects(()=>f.runner.run(Buffer.from('input'),async s=>{const waiting=s.request('sleep',{});stop.abort();return waiting},{signal:stop.signal}),{code:'ABORTED'})
  await empty(f.deploymentId)
  const startup=new AbortController(),pending=f.runner.run(Buffer.from('input'),s=>s.request('probe',{}),{signal:startup.signal})
  startup.abort();await assert.rejects(()=>pending,{code:'ABORTED'});await empty(f.deploymentId)
  const flood=await fixture('probe',{protocolBytes:16384})
  await assert.rejects(()=>flood.runner.run(Buffer.from('input'),s=>s.request('flood',{})),{code:'OUTPUT_LIMIT'});await empty(flood.deploymentId)
})

test('service manager kills native execution after controller SIGKILL',{timeout:15000},async()=>{
  const meta=JSON.parse(await readFile(process.env.DYOFFICE_TEST_HOST_MANIFEST,'utf8')),scope=randomUUID()
  const module=new URL('../../worker/src/sandbox/host-process.ts',import.meta.url).href
  const source=`import {createHostProcess} from ${JSON.stringify(module)};
    const runner=createHostProcess(${JSON.stringify({deploymentId:scope,binary:meta.probeBinary,sha256:meta.probeSha256,allowedCommands:['sleep'],limits:{wallMs:2000}})});
    await runner.run(Buffer.from('input'),async s=>{console.log('STARTED');return s.request('sleep',{})});`
  const child=spawn(process.execPath,['--experimental-strip-types','--input-type=module','-e',source],{stdio:['ignore','pipe','pipe']})
  let unit
  const ctl=args=>exec('/usr/bin/systemctl',args)
  try{
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('controller startup timeout')),5000)
      child.stdout.on('data',data=>{if(data.toString().includes('STARTED')){clearTimeout(timer);resolve()}})
      child.once('error',error=>{clearTimeout(timer);reject(error)})
      child.once('exit',()=>{clearTimeout(timer);reject(new Error('controller exited before signal'))})
    })
    unit=(await ctl(['list-units','--all','--plain','--no-legend','--no-pager','dyoffice-'+scope+'-*.service'])).stdout.trim().split(/\s+/)[0]
    assert.match(unit,new RegExp('^dyoffice-'+scope+'-'))
    const dead=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGKILL');await dead
    const deadline=Date.now()+7000
    let status=''
    while(Date.now()<deadline){
      status=(await ctl(['show',unit,'--property=ActiveState,MainPID,Result'])).stdout
      if(status.includes('MainPID=0')&&status.includes('ActiveState=failed'))break
      await new Promise(resolve=>setTimeout(resolve,50))
    }
    assert.match(status,/MainPID=0/);assert.match(status,/ActiveState=failed/);assert.match(status,/Result=timeout/)
  }finally{
    child.kill('SIGKILL')
    if(unit){await ctl(['stop',unit]);await ctl(['reset-failed',unit]).catch(()=>{});await rm('/var/tmp/'+unit.replace(/\.service$/,''),{recursive:true,force:true})}
  }
})
