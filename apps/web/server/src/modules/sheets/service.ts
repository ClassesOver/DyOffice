import {fetchRemoteTable} from '@genoffice/electron-utils/remote-table'
import type {LeaseService} from '../leases/service.ts'
import type {BoundWorkbookSource,FindInput,FormulaIndexSheet,RecalcInput} from '../../../../worker/src/native/xlsx.ts'
import {createHash,randomUUID} from 'node:crypto'
import type { createFileService } from '../files/service.ts'
import { authError } from '../auth/sessions.ts'
import type {WorkbookPackageQuery} from '../../../../worker/src/native/gateway.ts'
import {externalLinksResultSchema} from '../../../../../sheets/src/shared/external-links-contract.ts'
import { createWorkbookPasswordCodec } from '../files/workbook-password.ts'

const workbookPasswords = createWorkbookPasswordCodec()

type Files = ReturnType<typeof createFileService>
export interface SheetRange { startRow: number; endRow: number; startColumn: number; endColumn: number }
export interface ExternalLinkBinding { index: number; fileId: string; revision: string }
export type SheetsQueryFetcher = (source:string,signal?:AbortSignal)=>Promise<{headers:readonly string[];rows:readonly (readonly string[])[]}|null>
export interface SheetsQueryInput { revision:string; connectionId:string; editorId:string; leaseEpoch:number }
const fetchWorkbookQuery:SheetsQueryFetcher=(source,signal)=>fetchRemoteTable(source,{
  directPublic:true,maxBytes:2*1024*1024,timeoutMs:10_000,...(signal?{signal}:{}),
})
export type SheetsPackageReader = (bytes: Buffer, signal?: AbortSignal, query?: WorkbookPackageQuery) => Promise<unknown>
export interface SheetsNative {
  convertTsvImport?(input:Buffer,signal?:AbortSignal):Promise<Buffer>
  convertLegacyXls?(input:Buffer,signal?:AbortSignal):Promise<Buffer>
  convertMergeSource?(input:Buffer,format:'csv'|'tsv'|'xls',signal?:AbortSignal):Promise<Buffer>
  readMedia?(input:Uint8Array,visualId:string,signal?:AbortSignal):Promise<unknown>
  recalculate?(input: Uint8Array, request: RecalcInput, signal?: AbortSignal): Promise<unknown>
  readFormulaIndex?(input: Uint8Array, signal?: AbortSignal): Promise<FormulaIndexSheet[]>
  readSheet?(input: Uint8Array, sheetName: string, kind: 'formulas' | 'outline', signal?: AbortSignal): Promise<unknown>
  findCells?(input:Uint8Array,sheetName:string,request:FindInput,signal?:AbortSignal):Promise<unknown>
  refreshExternalLinks?(input:Uint8Array,sources:readonly BoundWorkbookSource[],signal?:AbortSignal):Promise<unknown>
  inspect(input: Uint8Array, signal?: AbortSignal, openingViewport?: boolean): Promise<unknown>
  readRange(input: Uint8Array, sheetName: string, range: SheetRange, signal?: AbortSignal): Promise<unknown>
}

/** Every operation captures an authorized immutable revision. No native process
 * session or filesystem path is accepted from the browser. */
export function createSheetsService({ files, native, readPackage, leases, fetchQuery = fetchWorkbookQuery, maxConcurrent = 2 }: { files: Files; native: SheetsNative; readPackage?: SheetsPackageReader; leases?: Pick<LeaseService,'renewLease'>; fetchQuery?: SheetsQueryFetcher; maxConcurrent?: number }) {
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 8) throw new Error('Invalid sheets concurrency')
  let active = 0
  let queryActive = false
  const mergeSessions = new Map<string,{tokenDigest:string;fileId:string;revision:string;bytes:Buffer;expiresAt:number;sheets:Set<string>;timer:NodeJS.Timeout}>()
  const maxMergeBytes=50*1024*1024,maxMergeSessionBytes=100*1024*1024,maxMergeSessions=8,mergeSessionTtlMs=10*60_000
  const mergeBytes=()=>[...mergeSessions.values()].reduce((total,session)=>total+session.bytes.length,0)
  const tokenDigest=(token:string)=>createHash('sha256').update(token).digest('hex')
  type Unlock = { tokenDigest:string; fileId:string; revision:string; sha256:string; bytes:Buffer; password:string; preparedPasswords:Map<string,string>; expiresAt:number; timer:NodeJS.Timeout }
  const unlocks = new Map<string, Unlock>()
  const unlockIdleMs = 10 * 60_000, maxUnlockBytes = 64 * 1024 * 1024, maxUnlocks = 8
  function disposeUnlock(id: string) {
    const grant=unlocks.get(id)
    if (grant) clearTimeout(grant.timer)
    unlocks.delete(id)
  }
  function touchUnlock(id: string, grant: Unlock) {
    clearTimeout(grant.timer)
    grant.expiresAt=Date.now()+unlockIdleMs
    grant.timer=setTimeout(()=>disposeUnlock(id),unlockIdleMs)
    grant.timer.unref()
  }
  function ownedUnlock(token: string, fileId: string, id: string): Unlock {
    const grant=unlocks.get(id)
    if (!grant || grant.expiresAt<=Date.now() || grant.tokenDigest!==tokenDigest(token) || grant.fileId!==fileId) throw authError(423)
    return grant
  }
  function authorizedUnlock(token:string,fileId:string,revision:string,id:string):Unlock {
    const grant=ownedUnlock(token,fileId,id)
    if(grant.revision!==revision)throw authError(423)
    return grant
  }
  function pruneMergeSessions(){const now=Date.now();for(const [id,session] of mergeSessions)if(session.expiresAt<=now){clearTimeout(session.timer);mergeSessions.delete(id)}}
  async function assertMergeContext(token:string,fileId:string,revision:string){
    const current=await files.openFile(token,fileId)
    if(current.format!=='xlsx')throw authError(415)
    if(current.file.revision!==revision)throw authError(409)
    return current
  }
  async function openUnlockedRevision(token:string,fileId:string,revision:string,id:string,signal?:AbortSignal) {
    const current=await assertMergeContext(token,fileId,revision)
    const grant=ownedUnlock(token,fileId,id)
    if(!current.workbookPasswordProtected)throw authError(423)
    if(grant.revision!==revision){
      // A save receipt can be lost. Advance only to a published head whose
      // ciphertext this exact unlock session previously prepared.
      const password=grant.preparedPasswords.get(current.file.sha256)
      if(password===undefined)throw authError(423)
      const source=await files.download(token,fileId,revision,undefined,signal)
      const opened=await workbookPasswords.open(source.bytes,password,signal)
      await assertMergeContext(token,fileId,revision)
      signal?.throwIfAborted()
      if(ownedUnlock(token,fileId,id)!==grant||opened.file.sha256!==current.file.sha256)throw authError(423)
      if(grant.revision!==revision){
        if(grant.preparedPasswords.get(opened.file.sha256)!==password)throw authError(423)
        const used=[...unlocks.values()].reduce((sum,entry)=>sum+entry.bytes.length,0)
        if(used-grant.bytes.length+opened.bytes.length>maxUnlockBytes)throw authError(429)
        grant.revision=revision;grant.sha256=opened.file.sha256;grant.bytes=opened.bytes;grant.password=password;grant.preparedPasswords.clear()
      }
    }
    if(current.file.sha256!==grant.sha256)throw authError(423)
    touchUnlock(id,grant)
    return grant
  }
  async function read(token: string, fileId: string, revision: string, operation: (bytes: Buffer) => Promise<unknown>, signal?: AbortSignal, unlockId?: string) {
    // Admission precedes object downloads, bounding captured input memory too.
    if (active >= maxConcurrent) throw Object.assign(authError(429), { retryAfter: 1 })
    active++
    try {
      signal?.throwIfAborted()
      if (unlockId) {
        const grant=await openUnlockedRevision(token,fileId,revision,unlockId,signal)
        signal?.throwIfAborted()
        const result=await operation(grant.bytes)
        signal?.throwIfAborted()
        await assertMergeContext(token,fileId,revision)
        if (authorizedUnlock(token,fileId,revision,unlockId)!==grant) throw authError(423)
        return result
      }
      const source = await files.download(token, fileId, revision)
      if (source.format !== 'xlsx') throw authError(415)
      if (source.workbookPasswordProtected) throw authError(423)
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
    async unlockWorkbook(token:string,fileId:string,revision:string,password:string,signal?:AbortSignal){
      if(token.startsWith('dsh-edit:'))throw authError(404)
      if(active>=maxConcurrent)throw Object.assign(authError(429),{retryAfter:1})
      active++
      try{
        signal?.throwIfAborted()
        const current=await assertMergeContext(token,fileId,revision)
        if(!current.workbookPasswordProtected)throw authError(400)
        const source=await files.download(token,fileId,revision,undefined,signal)
        const opened=await workbookPasswords.open(source.bytes,password,signal)
        if(opened.file.sha256!==current.file.sha256||opened.file.size!==current.file.size)throw authError(409)
        await assertMergeContext(token,fileId,revision)
        signal?.throwIfAborted()
        const used=[...unlocks.values()].reduce((sum,session)=>sum+session.bytes.length,0)
        if(unlocks.size>=maxUnlocks||used+opened.bytes.length>maxUnlockBytes)throw Object.assign(authError(429),{retryAfter:1})
        const unlockId=randomUUID(),timer=setTimeout(()=>disposeUnlock(unlockId),unlockIdleMs)
        timer.unref()
        unlocks.set(unlockId,{tokenDigest:tokenDigest(token),fileId,revision,sha256:opened.file.sha256,bytes:opened.bytes,password,preparedPasswords:new Map(),expiresAt:Date.now()+unlockIdleMs,timer})
        return {unlockId}
      }finally{active--}
    },
    async lockWorkbook(token:string,fileId:string,_revision:string,unlockId:string){
      ownedUnlock(token,fileId,unlockId)
      disposeUnlock(unlockId)
    },
    async openForProtectedSave(token:string,fileId:string,revision:string,id:string,signal?:AbortSignal){
      const grant=await openUnlockedRevision(token,fileId,revision,id,signal)
      const check=()=>{
        if(authorizedUnlock(token,fileId,revision,id)!==grant)throw authError(423)
        signal?.throwIfAborted()
      }
      return {bytes:grant.bytes,check,async seal(bytes:Buffer,password=grant.password){
        check()
        const sealed=await workbookPasswords.seal(bytes,password,signal)
        check()
        return {...sealed,rememberSave(){
          check()
          if(grant.preparedPasswords.size>=32)throw authError(429)
          grant.preparedPasswords.set(sealed.file.sha256,password)
        }}
      }}
    },
    readMedia: (token:string,fileId:string,revision:string,visualId:string,signal?:AbortSignal,unlockId?:string)=>read(token,fileId,revision,bytes=>{if(!native.readMedia)throw authError(501);return native.readMedia(bytes,visualId,signal)},signal,unlockId),
    recalculate: (token: string, fileId: string, revision: string, request: RecalcInput, signal?: AbortSignal, unlockId?:string) => read(token,fileId,revision,bytes=>{if(!native.recalculate)throw authError(501);return native.recalculate(bytes,request,signal)},signal,unlockId),
    readSheet: (token: string, fileId: string, revision: string, sheetName: string, kind: 'formulas' | 'outline', signal?: AbortSignal, unlockId?:string) => read(token,fileId,revision,bytes => { if (!native.readSheet) throw authError(501); return native.readSheet(bytes,sheetName,kind,signal) },signal,unlockId),
    findCells: (token:string,fileId:string,revision:string,sheetName:string,request:FindInput,signal?:AbortSignal,unlockId?:string) => read(token,fileId,revision,bytes=>{if(!native.findCells)throw authError(501);return native.findCells(bytes,sheetName,request,signal)},signal,unlockId),
    readPivotDefinition: (token:string,fileId:string,revision:string,path:string,cachePath:string,signal?:AbortSignal,unlockId?:string)=>read(token,fileId,revision,async bytes=>{
      if(!readPackage)throw authError(501)
      const metadata=await native.inspect(bytes,signal) as {sheets?:{pivotTables?:{path:string;cachePath:string|null}[]}[]}
      if(!metadata.sheets?.some(sheet=>sheet.pivotTables?.some(pivot=>pivot.path===path&&pivot.cachePath===cachePath)))throw authError(400)
      return readPackage(bytes,signal,{path,cachePath})
    },signal,unlockId),
    async refreshWebQuery(token:string,fileId:string,input:SheetsQueryInput,signal?:AbortSignal,unlockId?:string){
      if(!readPackage||!leases)throw authError(501)
      if(queryActive)throw Object.assign(authError(429),{retryAfter:1})
      queryActive=true
      try{
        const authority={editorId:input.editorId,leaseEpoch:input.leaseEpoch}
        const check=async(checkUnlock=false)=>{
          signal?.throwIfAborted()
          const current=await assertMergeContext(token,fileId,input.revision)
          if(current.officeSignatureProtected)throw authError(403)
          await leases.renewLease(token,fileId,authority)
          if(checkUnlock&&current.workbookPasswordProtected){
            if(!unlockId)throw authError(423)
            authorizedUnlock(token,fileId,input.revision,unlockId)
          }
        }
        await check()
        const {source}=await read(token,fileId,input.revision,bytes=>readPackage(bytes,signal,{webQuery:input.connectionId}),signal,unlockId) as {source?:unknown}
        if(typeof source!=='string'||!source.length||source.length>4096)throw authError(400)
        await check(true)
        const table=await fetchQuery(source,signal).catch(()=>null)
        if(!table||(!table.headers.length&&!table.rows.length))throw Object.assign(new Error('Could not read the workbook web query'),{statusCode:502})
        const rows=[table.headers,...table.rows]
        let cells=0,characters=0
        for(const row of rows){
          cells+=row.length
          for(const cell of row)characters+=cell.length
          if(cells>100_000||characters>2*1024*1024)throw Object.assign(new Error('Web query exceeds the table limit'),{statusCode:413})
        }
        await check(true)
        return {headers:table.headers,rows:table.rows}
      }finally{queryActive=false}
    },
    listExternalLinks: (token:string,fileId:string,revision:string,signal?:AbortSignal,unlockId?:string)=>read(token,fileId,revision,async bytes=>{
      if(!readPackage)throw authError(501)
      const {links}=externalLinksResultSchema.parse(await readPackage(bytes,signal,{externalLinks:true}))
      return native.refreshExternalLinks?{links,workspaceSources:true}:{links}
    },signal,unlockId),
    previewExternalLinkRefresh: (token:string,fileId:string,revision:string,bindings:readonly ExternalLinkBinding[],signal?:AbortSignal)=>read(token,fileId,revision,async bytes=>{
      if(!native.refreshExternalLinks)throw authError(501)
      const indices=new Set(bindings.map(binding=>binding.index))
      if(bindings.length>256||indices.size!==bindings.length||
        bindings.some(({index})=>!Number.isInteger(index)||index<1||index>256))throw authError(400)
      let remaining=32*1024*1024-bytes.length
      const sources:BoundWorkbookSource[]=[]
      for(const binding of bindings){
        signal?.throwIfAborted()
        const source=await files.download(token,binding.fileId,binding.revision,remaining)
        if(source.format!=='xlsx')throw authError(415)
        remaining-=source.bytes.length
        sources.push({index:binding.index,bytes:source.bytes})
      }
      signal?.throwIfAborted()
      const report=await native.refreshExternalLinks(bytes,sources,signal)
      for(const sourceFileId of new Set(bindings.map(binding=>binding.fileId))){
        signal?.throwIfAborted()
        await files.openFile(token,sourceFileId)
      }
      return report
    },signal),
    readPackage: (token: string, fileId: string, revision: string, signal?: AbortSignal, unlockId?:string) => read(token,fileId,revision,bytes => { if (!readPackage) throw authError(501); return readPackage(bytes,signal) },signal,unlockId),
    inspect: (token: string, fileId: string, revision: string, signal?: AbortSignal, openingViewport=false, unlockId?:string) => read(token, fileId, revision, bytes => native.inspect(bytes, signal, openingViewport), signal,unlockId),
    readRange: (token: string, fileId: string, revision: string, sheetName: string, range: SheetRange, signal?: AbortSignal, unlockId?:string) => read(token, fileId, revision, bytes => native.readRange(bytes, sheetName, range, signal), signal,unlockId),
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

