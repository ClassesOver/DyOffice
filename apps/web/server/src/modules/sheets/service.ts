import type {FindInput,RecalcInput} from '../../../../worker/src/native/xlsx.ts'
import {createHash,randomUUID} from 'node:crypto'
import type { createFileService } from '../files/service.ts'
import { authError } from '../auth/sessions.ts'
import type {WorkbookPackageQuery} from '../../../../worker/src/native/gateway.ts'

type Files = ReturnType<typeof createFileService>
export interface SheetRange { startRow: number; endRow: number; startColumn: number; endColumn: number }
export type SheetsPackageReader = (bytes: Buffer, signal?: AbortSignal, query?: WorkbookPackageQuery) => Promise<unknown>
export interface SheetsNative {
  convertMergeSource?(input:Buffer,format:'csv'|'tsv'|'xls',signal?:AbortSignal):Promise<Buffer>
  readMedia?(input:Uint8Array,visualId:string,signal?:AbortSignal):Promise<unknown>
  recalculate?(input: Uint8Array, request: RecalcInput, signal?: AbortSignal): Promise<unknown>
  readSheet?(input: Uint8Array, sheetName: string, kind: 'formulas' | 'outline', signal?: AbortSignal): Promise<unknown>
  findCells?(input:Uint8Array,sheetName:string,request:FindInput,signal?:AbortSignal):Promise<unknown>
  inspect(input: Uint8Array, signal?: AbortSignal): Promise<unknown>
  readRange(input: Uint8Array, sheetName: string, range: SheetRange, signal?: AbortSignal): Promise<unknown>
}

/** Every operation captures an authorized immutable revision. No native process
 * session or filesystem path is accepted from the browser. */
export function createSheetsService({ files, native, readPackage, maxConcurrent = 2 }: { files: Files; native: SheetsNative; readPackage?: SheetsPackageReader; maxConcurrent?: number }) {
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 8) throw new Error('Invalid sheets concurrency')
  let active = 0
  const mergeSessions = new Map<string,{tokenDigest:string;fileId:string;revision:string;bytes:Buffer;expiresAt:number;sheets:Set<string>;timer:NodeJS.Timeout}>()
  const maxMergeBytes=50*1024*1024,maxMergeSessionBytes=100*1024*1024,maxMergeSessions=8,mergeSessionTtlMs=10*60_000
  const mergeBytes=()=>[...mergeSessions.values()].reduce((total,session)=>total+session.bytes.length,0)
  const tokenDigest=(token:string)=>createHash('sha256').update(token).digest('hex')
  function pruneMergeSessions(){const now=Date.now();for(const [id,session] of mergeSessions)if(session.expiresAt<=now){clearTimeout(session.timer);mergeSessions.delete(id)}}
  async function assertMergeContext(token:string,fileId:string,revision:string){
    const current=await files.openFile(token,fileId)
    if(current.format!=='xlsx')throw authError(415)
    if(current.file.revision!==revision)throw authError(409)
    return current
  }
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
    findCells: (token:string,fileId:string,revision:string,sheetName:string,request:FindInput,signal?:AbortSignal) => read(token,fileId,revision,bytes=>{if(!native.findCells)throw authError(501);return native.findCells(bytes,sheetName,request,signal)},signal),
    readPivotDefinition: (token:string,fileId:string,revision:string,path:string,cachePath:string,signal?:AbortSignal)=>read(token,fileId,revision,async bytes=>{
      if(!readPackage)throw authError(501)
      const metadata=await native.inspect(bytes,signal) as {sheets?:{pivotTables?:{path:string;cachePath:string|null}[]}[]}
      if(!metadata.sheets?.some(sheet=>sheet.pivotTables?.some(pivot=>pivot.path===path&&pivot.cachePath===cachePath)))throw authError(400)
      return readPackage(bytes,signal,{path,cachePath})
    },signal),
    listExternalLinks: (token:string,fileId:string,revision:string,signal?:AbortSignal)=>read(token,fileId,revision,bytes=>{
      if(!readPackage)throw authError(501)
      return readPackage(bytes,signal,{externalLinks:true})
    },signal),
    readPackage: (token: string, fileId: string, revision: string, signal?: AbortSignal) => read(token,fileId,revision,bytes => { if (!readPackage) throw authError(501); return readPackage(bytes,signal) },signal),
    inspect: (token: string, fileId: string, revision: string, signal?: AbortSignal) => read(token, fileId, revision, bytes => native.inspect(bytes, signal), signal),
    readRange: (token: string, fileId: string, revision: string, sheetName: string, range: SheetRange, signal?: AbortSignal) => read(token, fileId, revision, bytes => native.readRange(bytes, sheetName, range, signal), signal),
    async openMergeWorkbook(token:string,fileId:string,revision:string,input:Uint8Array,name:string,signal?:AbortSignal){
      pruneMergeSessions()
      if(!input||input.byteLength<1||input.byteLength>maxMergeBytes||typeof name!=='string'||name.length<1||name.length>255||/[\\/\x00-\x1f\x7f]/.test(name)||!/\.(xlsx|xlsm|xls|csv|tsv)$/i.test(name))throw authError(400)
      const format=name.split('.').at(-1)?.toLowerCase()
      if(mergeSessions.size>=maxMergeSessions||active>=maxConcurrent)throw Object.assign(authError(429),{retryAfter:1})
      active++
      try{
        signal?.throwIfAborted()
        await assertMergeContext(token,fileId,revision)
        const source=Buffer.from(input)
        let bytes:Buffer=source
        if(format==='csv'||format==='tsv'||format==='xls'){
          if(!native.convertMergeSource)throw authError(501)
          bytes=await native.convertMergeSource(source,format,signal)
        }
        const metadata=await native.inspect(bytes,signal) as Record<string,unknown>
        if(!metadata||!Array.isArray(metadata.sheets)||metadata.sheets.length<1)throw authError(400)
        signal?.throwIfAborted()
        await assertMergeContext(token,fileId,revision)
        pruneMergeSessions()
        if(mergeSessions.size>=maxMergeSessions||mergeBytes()+bytes.length>maxMergeSessionBytes)throw Object.assign(authError(429),{retryAfter:1})
        const id=randomUUID(),sheets=metadata.sheets as {id:string;name:string}[]
        if(sheets.some(sheet=>typeof sheet?.id!=='string'||typeof sheet.name!=='string'))throw authError(400)
        const expiresAt=Date.now()+mergeSessionTtlMs,timer=setTimeout(()=>{const session=mergeSessions.get(id);if(session?.expiresAt===expiresAt)mergeSessions.delete(id)},mergeSessionTtlMs)
        timer.unref()
        mergeSessions.set(id,{tokenDigest:tokenDigest(token),fileId,revision,bytes,expiresAt,sheets:new Set(sheets.map(sheet=>sheet.name)),timer})
        return {...metadata,sessionId:id,name,sha256:createHash('sha256').update(source).digest('hex'),fileBytes:source.length,readOnly:true,needsSaveAs:false,automaticRecoveryDisabled:true}
      }catch(error){
        // The native sandbox caps input below maxMergeBytes; report that as 413, not a generic 500.
        if((error as {code?:unknown})?.code==='INPUT_LIMIT'||(error as Error)?.message==='INPUT_LIMIT')throw authError(413)
        throw error
      }finally{active--}
    },
    async readMergeWorkbookRange(token:string,fileId:string,revision:string,sessionId:string,sheetName:string,range:SheetRange,signal?:AbortSignal){
      pruneMergeSessions()
      const session=mergeSessions.get(sessionId)
      if(!session||session.tokenDigest!==tokenDigest(token)||session.fileId!==fileId||session.revision!==revision||!session.sheets.has(sheetName))throw authError(404)
      if(active>=maxConcurrent)throw Object.assign(authError(429),{retryAfter:1})
      active++
      try{signal?.throwIfAborted();await assertMergeContext(token,fileId,revision);const result=await native.readRange(session.bytes,sheetName,range,signal);signal?.throwIfAborted();await assertMergeContext(token,fileId,revision);return result}
      finally{active--}
    },
    async closeMergeWorkbook(token:string,fileId:string,revision:string,sessionId:string){
      pruneMergeSessions()
      const session=mergeSessions.get(sessionId)
      if(!session||session.tokenDigest!==tokenDigest(token)||session.fileId!==fileId)throw authError(404)
      // Closing only releases this caller's own buffered source, so it must still work after the
      // host workbook was saved (head revision moved); re-authenticate without pinning the revision.
      void revision
      await files.openFile(token,fileId)
      clearTimeout(session.timer)
      mergeSessions.delete(sessionId)
    },
  }
}

