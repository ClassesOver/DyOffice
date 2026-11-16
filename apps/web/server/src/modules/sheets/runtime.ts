import {resolve} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {createHostProcess} from '../../../../worker/src/sandbox/host-process.ts'
import {recoverHostProcesses} from '../../../../worker/src/sandbox/host-recovery.ts'
import {createXlsxNativeWorker} from '../../../../worker/src/native/xlsx.ts'
import type {SandboxSession} from '../../../../worker/src/sandbox/contracts.ts'
import type {SheetsPlanner} from './save.ts'
import type {SheetsPackageReader} from './service.ts'

/** Explicit experimental startup only. All parsers run behind the existing
 * host isolation boundary, with shared shutdown cancellation and bounded slots. */
export async function configuredSheetsRuntime(environment: NodeJS.ProcessEnv = process.env) {
  const flag=environment.DYOFFICE_NATIVE_XLSX
  if (!flag) return undefined
  if (flag!=='experimental' || environment.DYOFFICE_AUTH_MODE!=='local' || environment.NODE_ENV==='production') throw new Error('Native Sheets requires experimental local mode')
  const binary=environment.DYOFFICE_NATIVE_BINARY,sha256=environment.DYOFFICE_NATIVE_SHA256,deploymentId=environment.DYOFFICE_DEPLOYMENT_ID
  if (!binary || !sha256 || !deploymentId) throw new Error('Native Sheets configuration missing')
  const sandbox=createHostProcess({binary,sha256,deploymentId,allowedCommands:['open','close','read_range','read_formula_cells','read_row_outline','recalc_cells','save_archive']})
  const gatewayPath=resolve(environment.DYOFFICE_XLSX_GATEWAY_MODULE ?? fileURLToPath(new URL('../../../../dist-sheets-server/gateway.mjs',import.meta.url)))
  const gateway=await import(pathToFileURL(gatewayPath).href) as {planWorkbookSave:SheetsPlanner;readWorkbookPackage:SheetsPackageReader}
  if (typeof gateway.planWorkbookSave!=='function' || typeof gateway.readWorkbookPackage!=='function') throw new Error('Native Sheets gateway build missing')
  await recoverHostProcesses(deploymentId)
  // Starting the actual binary verifies hash, execution and sandbox readiness.
  await sandbox.run(Buffer.from('sheets-startup'),async()=>{})
  const controller=new AbortController(),active=new Set<Promise<unknown>>()
  const process={
    async run<T>(bytes: Uint8Array,execute:(io:SandboxSession)=>Promise<T>,options?:{signal?:AbortSignal}):Promise<T>{
      const signal=options?.signal ? AbortSignal.any([controller.signal,options.signal]) : controller.signal
      const pending=sandbox.run(bytes,execute,{signal});active.add(pending)
      try {return await pending} finally {active.delete(pending)}
    },
  }
  return {
    sheetsNative:createXlsxNativeWorker(process),sheetsPlanner:gateway.planWorkbookSave,sheetsPackageReader:gateway.readWorkbookPackage,
    nativeSheetsDirectory:resolve(environment.DYOFFICE_NATIVE_XLSX_DIRECTORY ?? fileURLToPath(new URL('../../../../dist-sheets/',import.meta.url))),
    async close(){controller.abort();await Promise.allSettled([...active])},
  }
}
