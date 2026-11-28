import {assertDocumentBackendPolicy} from '../../../../worker/src/sandbox/document-backend-policy.ts'
import {resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {open} from 'node:fs/promises'
import {constants,existsSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {createHostProcess} from '../../../../worker/src/sandbox/host-process.ts'
import {createCrossPlatformProcess} from '../../../../worker/src/sandbox/cross-platform-process.ts'
import {recoverHostProcesses} from '../../../../worker/src/sandbox/host-recovery.ts'
import {createXlsxNativeWorker} from '../../../../worker/src/native/xlsx.ts'
import {createGatewayAdapter} from '../../../../worker/src/native/gateway.ts'
import type {SandboxSession} from '../../../../worker/src/sandbox/contracts.ts'
import type {SheetsPlanner} from './save.ts'
import type {SheetsPackageReader} from './service.ts'

async function executableHash(path:string,max:number){
  const file=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0))
  try{
    const stat=await file.stat()
    if(!stat.isFile()||stat.size<1||stat.size>max)throw new Error('Invalid gateway executable')
    const hash=createHash('sha256');for await(const chunk of file.createReadStream({autoClose:false}))hash.update(chunk)
    return hash.digest('hex')
  }finally{await file.close()}
}

/** The Web entrypoint selects the built runtime. All parsers run in child
 * processes, with shared shutdown cancellation and bounded slots. */
export async function configuredSheetsRuntime(environment: NodeJS.ProcessEnv = process.env, {enabled=false}:{enabled?:boolean}={}) {
  assertDocumentBackendPolicy(environment)
  if (!enabled) return undefined
  if (environment.DYOFFICE_AUTH_MODE!=='local' || environment.NODE_ENV==='production') throw new Error('Native Sheets requires local mode')
  const nodeEngine=environment.DYOFFICE_XLSX_NODE_ENGINE
  const binary=environment.DYOFFICE_NATIVE_BINARY,sha256=environment.DYOFFICE_NATIVE_SHA256,deploymentId=environment.DYOFFICE_DEPLOYMENT_ID
  const rust=binary&&sha256?{binary,sha256}:undefined
  if (Boolean(binary)!==Boolean(sha256)||(!rust&&!nodeEngine)||!deploymentId) throw new Error('Native Sheets configuration missing')
  const wasiRunner=!rust&&nodeEngine?environment.DYOFFICE_XLSX_WASI_REFRESH_RUNNER:undefined
  const useSystemd=Boolean(rust||wasiRunner) && process.platform==='linux' && process.getuid?.()===0 && existsSync('/usr/bin/systemd-run') && environment.DYOFFICE_SANDBOX_MODE!=='subprocess'
  const createCalculationProcess=useSystemd ? createHostProcess : createCrossPlatformProcess
  const createGatewayProcess=nodeEngine ? createCrossPlatformProcess : createCalculationProcess
  const execSha=await executableHash(process.execPath,160*1024*1024)
  const allowedEngineCommands=['open','close','read_range','read_formula_cells','read_row_outline','read_media','find_cells','recalc_cells','save_archive'] as const
  const calculationCommands=['open','close','recalc_cells','refresh_bound_external_links','convert_legacy_xls'] as const
  const rustSandbox=rust&&createCalculationProcess({...rust,deploymentId,
    allowedCommands:nodeEngine?calculationCommands:[...allowedEngineCommands,'refresh_bound_external_links','convert_legacy_xls'],
  })
  const sandbox=nodeEngine
    ? createCrossPlatformProcess({binary:process.execPath,sha256:execSha,deploymentId,script:{path:resolve(nodeEngine),sha256:await executableHash(resolve(nodeEngine),32*1024*1024)},allowedCommands:allowedEngineCommands})
    : rustSandbox!
  const refreshSandbox=rustSandbox ?? (wasiRunner ? createCalculationProcess({
    binary:process.execPath,sha256:execSha,deploymentId,
    script:{path:resolve(wasiRunner),sha256:await executableHash(resolve(wasiRunner),32*1024*1024)},
    allowedCommands:calculationCommands,
  }) : undefined)
  if(environment.DYOFFICE_XLSX_GATEWAY_MODULE)throw new Error('In-process gateway configuration is not supported; build the isolated gateway runner')
  const gatewayPath=resolve(environment.DYOFFICE_XLSX_GATEWAY_RUNNER ?? fileURLToPath(new URL('../../../../dist-sheets-server/gateway-process.mjs',import.meta.url)))
  const gatewaySandbox=createGatewayProcess({binary:process.execPath,sha256:execSha,deploymentId,script:{path:gatewayPath,sha256:await executableHash(gatewayPath,32*1024*1024)},allowedCommands:['gateway_package','gateway_plan','gateway_convert_merge_source']})
  if (useSystemd) await recoverHostProcesses(deploymentId)
  // Starting the actual binary verifies hash, execution and sandbox readiness.
  await sandbox.run(Buffer.from('sheets-startup'),async()=>{})
  if(refreshSandbox&&refreshSandbox!==sandbox)await refreshSandbox.run(Buffer.from('sheets-refresh-startup'),async()=>{})
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
  const native=createXlsxNativeWorker(tracked(sandbox),Boolean(nodeEngine))
  const refresh=refreshSandbox===sandbox?native:refreshSandbox?createXlsxNativeWorker(tracked(refreshSandbox)):undefined
  return {
    sheetsNative:{
      ...native,
      // The Node reader returns stored values; it cannot evaluate formulas.
      recalculate:refresh?.recalculate ?? (!nodeEngine ? native.recalculate : undefined),
      refreshExternalLinks:refresh?.refreshExternalLinks,
      convertMergeSource:gateway.convertMergeSource,
      convertTsvImport:gateway.convertTsvImport,
      convertLegacyXls:refresh?.convertLegacyXls,
    },sheetsPlanner:gateway.planWorkbookSave as SheetsPlanner,sheetsWorkbookPlanner:gateway.planFromWorkbook,sheetsPackageReader:gateway.readWorkbookPackage as SheetsPackageReader,
    nativeSheetsDirectory:resolve(environment.DYOFFICE_NATIVE_XLSX_DIRECTORY ?? fileURLToPath(new URL('../../../../dist-sheets/',import.meta.url))),
    async close(){controller.abort();await Promise.allSettled([...active])},
  }
}

