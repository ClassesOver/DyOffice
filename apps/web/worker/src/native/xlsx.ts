import { SandboxError, type SandboxSession } from '../sandbox/contracts.ts'

type Opened = { sessionId: string; sheets: { name: string }[] }
function opened(value: unknown): Opened {
  const result = value as Opened
  if (!result || typeof result.sessionId!=='string' || !/^[a-f0-9-]{36}$/.test(result.sessionId) || !Array.isArray(result.sheets) || result.sheets.length<1 || result.sheets.length>256 || result.sheets.some(sheet => !sheet || typeof sheet.name!=='string')) throw new SandboxError('INVALID_PROTOCOL')
  return result
}
interface NativeProcess {
  run<T>(input: Uint8Array,execute: (session: SandboxSession) => Promise<T>,options?: { signal?: AbortSignal }): Promise<T>
}
/** Uses the original sidecar's archive writer. This is an archive roundtrip,
 * not an editor or persisted recalculation implementation. */
export function createXlsxNativeWorker(process: NativeProcess) {
  return {
    roundtrip(input: Uint8Array,signal?: AbortSignal) {
      return process.run(input,async io => {
        const source = opened(await io.request('open',{ path: '/work/input.xlsx',locale: 'en' }))
        await io.request('save_archive',{ sourcePath: '/work/input.xlsx',targetPath: '/work/output.xlsx',replacements: [],removals: [],additions: [] })
        const saved = opened(await io.request('open',{ path: '/work/output.xlsx',locale: 'en' }))
        if (source.sheets.length!==saved.sheets.length || source.sheets.some((sheet,i) => sheet.name!==saved.sheets[i].name)) throw new SandboxError('INVALID_OUTPUT')
        const output = await io.readOutput()
        for (const sessionId of [source.sessionId,saved.sessionId]) await io.request('close',{ sessionId })
        return { bytes: output,sheetCount: saved.sheets.length }
      },{ signal })
    },
  }
}
