import {assertDocumentBackendPolicy} from '../../../../worker/src/sandbox/document-backend-policy.ts'
import {resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {open} from 'node:fs/promises'
import {constants} from 'node:fs'
import {createHash} from 'node:crypto'
import {createHostProcess} from '../../../../worker/src/sandbox/host-process.ts'
import {recoverHostProcesses} from '../../../../worker/src/sandbox/host-recovery.ts'
import {createXlsxNativeWorker} from '../../../../worker/src/native/xlsx.ts'
import {createGatewayAdapter} from '../../../../worker/src/native/gateway.ts'
import type {SandboxSession} from '../../../../worker/src/sandbox/contracts.ts'
import type {SheetsPlanner} from './save.ts'
import type {SheetsPackageReader} from './service.ts'

async function executableHash(path:string,max:number){
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK)
  try{
    const stat=await file.stat()
    if(!stat.isFile()||stat.size<1||stat.size>max)throw new Error('Invalid gateway executable')
    const hash=createHash('sha256');for await(const chunk of file.createReadStream({autoClose:false}))hash.update(chunk)
    return hash.digest('hex')
  }finally{await file.close()}
}

/** Explicit experimental startup only. All parsers run behind the existing
 * host isolation boundary, with shared shutdown cancellation and bounded slots. */
export async function configuredSheetsRuntime(environment: NodeJS.ProcessEnv = process.env) {
  assertDocumentBackendPolicy(environment)
  const flag=environment.DYOFFICE_NATIVE_XLSX
  if (!flag) return undefined
  if (flag!=='experimental' || environment.DYOFFICE_AUTH_MODE!=='local' || environment.NODE_ENV==='production') throw new Error('Native Sheets requires experimental local mode')
  const binary=environment.DYOFFICE_NATIVE_BINARY,sha256=environment.DYOFFICE_NATIVE_SHA256,deploymentId=environment.DYOFFICE_DEPLOYMENT_ID
  if (!binary || !sha256 || !deploymentId) throw new Error('Native Sheets configuration missing')
  const sandbox=createHostProcess({binary,sha256,deploymentId,allowedCommands:['open','close','read_range','read_formula_cells','read_row_outline','read_media','recalc_cells','save_archive']})
  if(environment.DYOFFICE_XLSX_GATEWAY_MODULE)throw new Error('In-process gateway configuration is not supported; build the isolated gateway runner')
  const gatewayPath=resolve(environment.DYOFFICE_XLSX_GATEWAY_RUNNER ?? fileURLToPath(new URL('../../../../dist-sheets-server/gateway-process.mjs',import.meta.url)))
  const gatewaySandbox=createHostProcess({binary:process.execPath,sha256:await executableHash(process.execPath,160*1024*1024),deploymentId,script:{path:gatewayPath,sha256:await executableHash(gatewayPath,32*1024*1024)},allowedCommands:['gateway_package','gateway_plan']})
  await recoverHostProcesses(deploymentId)
  // Starting the actual binary verifies hash, execution and sandbox readiness.
  await sandbox.run(Buffer.from('sheets-startup'),async()=>{})
  await gatewaySandbox.run(Buffer.from('gateway-startup'),async()=>{})
  const controller=new AbortController(),active=new Set<Promise<unknown>>()
  const tracked=(backend:ReturnType<typeof createHostProcess>)=>({
    async run<T>(bytes: Uint8Array,execute:(io:SandboxSession)=>Promise<T>,options?:{signal?:AbortSignal}):Promise<T>{
      const signal=options?.signal ? AbortSignal.any([controller.signal,options.signal]) : controller.signal
      const pending=backend.run(bytes,execute,{signal});active.add(pending)
      try {return await pending} finally {active.delete(pending)}
    },
  })
  const gateway=createGatewayAdapter(tracked(gatewaySandbox))
  return {
    sheetsNative:createXlsxNativeWorker(tracked(sandbox)),sheetsPlanner:gateway.planWorkbookSave as SheetsPlanner,sheetsWorkbookPlanner:gateway.planFromWorkbook,sheetsPackageReader:gateway.readWorkbookPackage as SheetsPackageReader,
    nativeSheetsDirectory:resolve(environment.DYOFFICE_NATIVE_XLSX_DIRECTORY ?? fileURLToPath(new URL('../../../../dist-sheets/',import.meta.url))),
    async close(){controller.abort();await Promise.allSettled([...active])},
  }
}

