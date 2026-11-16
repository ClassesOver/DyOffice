import type {RecalcInput} from '../../../../worker/src/native/xlsx.ts'
import type { createFileService } from '../files/service.ts'
import { authError } from '../auth/sessions.ts'

type Files = ReturnType<typeof createFileService>
export interface SheetRange { startRow: number; endRow: number; startColumn: number; endColumn: number }
export type SheetsPackageReader = (bytes: Buffer, signal?: AbortSignal) => Promise<unknown>
export interface SheetsNative {
  readMedia?(input:Uint8Array,visualId:string,signal?:AbortSignal):Promise<unknown>
  recalculate?(input: Uint8Array, request: RecalcInput, signal?: AbortSignal): Promise<unknown>
  readSheet?(input: Uint8Array, sheetName: string, kind: 'formulas' | 'outline', signal?: AbortSignal): Promise<unknown>
  inspect(input: Uint8Array, signal?: AbortSignal): Promise<unknown>
  readRange(input: Uint8Array, sheetName: string, range: SheetRange, signal?: AbortSignal): Promise<unknown>
}

/** Every operation captures an authorized immutable revision. No native process
 * session or filesystem path is accepted from the browser. */
export function createSheetsService({ files, native, readPackage, maxConcurrent = 2 }: { files: Files; native: SheetsNative; readPackage?: SheetsPackageReader; maxConcurrent?: number }) {
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 8) throw new Error('Invalid sheets concurrency')
  let active = 0
  async function read(token: string, fileId: string, revision: string, operation: (bytes: Buffer) => Promise<unknown>, signal?: AbortSignal) {
    // Admission precedes object downloads, bounding captured input memory too.
    if (active >= maxConcurrent) throw Object.assign(authError(429), { retryAfter: 1 })
    active++
    try {
      signal?.throwIfAborted()
      const source = await files.download(token, fileId, revision)
      if (source.format !== 'xlsx') throw authError(415)
      signal?.throwIfAborted()
      const result = await operation(source.bytes)
      signal?.throwIfAborted()
      // Native work runs outside the database transaction. Reauthenticate and
      // check that the file is still visible before releasing its result.
      await files.openFile(token, fileId)
      return result
    } finally { active-- }
  }
  return {
    readMedia: (token:string,fileId:string,revision:string,visualId:string,signal?:AbortSignal)=>read(token,fileId,revision,bytes=>{if(!native.readMedia)throw authError(501);return native.readMedia(bytes,visualId,signal)},signal),
    recalculate: (token: string, fileId: string, revision: string, request: RecalcInput, signal?: AbortSignal) => read(token,fileId,revision,bytes=>{if(!native.recalculate)throw authError(501);return native.recalculate(bytes,request,signal)},signal),
    readSheet: (token: string, fileId: string, revision: string, sheetName: string, kind: 'formulas' | 'outline', signal?: AbortSignal) => read(token,fileId,revision,bytes => { if (!native.readSheet) throw authError(501); return native.readSheet(bytes,sheetName,kind,signal) },signal),
    readPackage: (token: string, fileId: string, revision: string, signal?: AbortSignal) => read(token,fileId,revision,bytes => { if (!readPackage) throw authError(501); return readPackage(bytes,signal) },signal),
    inspect: (token: string, fileId: string, revision: string, signal?: AbortSignal) => read(token, fileId, revision, bytes => native.inspect(bytes, signal), signal),
    readRange: (token: string, fileId: string, revision: string, sheetName: string, range: SheetRange, signal?: AbortSignal) => read(token, fileId, revision, bytes => native.readRange(bytes, sheetName, range, signal), signal),
  }
}

