import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile,writeFile,mkdtemp,rm,readdir} from 'node:fs/promises'
import {randomUUID,createHash} from 'node:crypto'
import {join,dirname} from 'node:path'
import {tmpdir} from 'node:os'
import {buildSheetsGateway} from '../../server/sheets/build.mjs'
import {createHostProcess} from '../../worker/src/sandbox/host-process.ts'
import {createGatewayAdapter} from '../../worker/src/native/gateway.ts'
import {sheetsSaveRequest} from '../helpers/sheets-request.mjs'

const hash=async path=>createHash('sha256').update(await readFile(path)).digest('hex')
async function host(script,deploymentId=randomUUID()) {
  return createHostProcess({binary:process.execPath,sha256:await hash(process.execPath),deploymentId,script:{path:script,sha256:await hash(script)},allowedCommands:['gateway_package','gateway_plan']})
}
test('real Node gateway parses and plans inside the existing host sandbox', {timeout:60000},async t=>{
  const directory=await mkdtemp(join(tmpdir(),'dyoffice-gateway-'));t.after(()=>rm(directory,{recursive:true,force:true}))
  const module=await buildSheetsGateway(join(directory,'gateway.mjs'))
  const gateway=createGatewayAdapter(await host(join(dirname(module),'gateway-process.mjs')))
  const input=await readFile(new URL('../fixtures/sheets/acceptance.xlsx',import.meta.url))
  assert.deepEqual((await gateway.readWorkbookPackage(input)).redactions,{status:'absent'})
  const plan=await gateway.planWorkbookSave(input,[{id:'1',name:'Acceptance'}],sheetsSaveRequest('1',[{row:1,column:0,writeValue:true,value:23}]))
  assert.match(plan.replaced.get('xl/worksheets/sheet1.xml'),/<v>23<\/v>/)
  assert.equal(plan.replaced.has('customXml/t09-preserve.xml'),false)
  await assert.rejects(()=>gateway.planWorkbookSave(input,[{id:'other',name:'Acceptance'}],sheetsSaveRequest('1',[{row:1,column:0,writeValue:true,value:23}])),{statusCode:400})
})
test('cancelling an active Node sandbox terminates it and removes its own preparation root', {timeout:20000},async t=>{
  const directory=await mkdtemp(join(tmpdir(),'dyoffice-gateway-cancel-'));t.after(()=>rm(directory,{recursive:true,force:true}))
  const script=join(directory,'wait.mjs'),deploymentId=randomUUID(),controller=new AbortController()
  await writeFile(script,"import readline from 'node:readline';for await (const line of readline.createInterface({input:process.stdin})){await new Promise(()=>{})}")
  const process=await host(script,deploymentId)
  await assert.rejects(()=>process.run(Buffer.from('test'),async io=>{
    const timer=setTimeout(()=>controller.abort(),100)
    try{await io.request('gateway_package',{})}finally{clearTimeout(timer)}
  },{signal:controller.signal}),{code:'ABORTED'})
  assert.equal((await readdir('/var/tmp')).some(name=>name.startsWith('dyoffice-'+deploymentId+'-')),false)
})
test('Node script retains dynamic UID, private root and credential stripping', {timeout:20000},async t=>{
  const directory=await mkdtemp(join(tmpdir(),'dyoffice-gateway-policy-'));t.after(()=>rm(directory,{recursive:true,force:true}))
  const script=join(directory,'probe.mjs')
  await writeFile(script,"import fs from 'node:fs';import readline from 'node:readline';for await(const line of readline.createInterface({input:process.stdin})){const p=JSON.parse(line);process.stdout.write(JSON.stringify({version:1,requestId:p.requestId,ok:true,result:{uid:process.getuid(),secret:process.env.DYOFFICE_TEST_PRIVATE_MARKER??null,hostFiles:fs.existsSync('/etc/passwd'),cap:fs.readFileSync('/proc/self/status','utf8').match(/^CapEff:\\s+(.*)$/m)?.[1]}})+'\\n')}")
  const original=process.env.DYOFFICE_TEST_PRIVATE_MARKER
  process.env.DYOFFICE_TEST_PRIVATE_MARKER='controller-only'
  try{
    const sandbox=await host(script)
    const result=await sandbox.run(Buffer.from('test'),io=>io.request('gateway_package',{}))
    assert.ok(result.uid>0);assert.equal(result.secret,null);assert.equal(result.hostFiles,false);assert.match(result.cap,/^0+$/)
  }finally{if(original===undefined)delete process.env.DYOFFICE_TEST_PRIVATE_MARKER;else process.env.DYOFFICE_TEST_PRIVATE_MARKER=original}
})
