import { createHash } from 'node:crypto'
import { MAX_OBJECT_BYTES } from '../../storage/object-store.ts'
import type { FileService } from '../files/service.ts'
import type { LeaseService } from '../leases/service.ts'
import type { RevisionService } from '../revisions/service.ts'
import { authError } from '../auth/sessions.ts'
import { validateFileName } from '../files/validation-core.ts'
import type { XlsxMutationPlan } from '../../../../worker/src/native/xlsx.ts'
import type { createSheetsService } from './service.ts'
import type { createWorkbookPasswordCodec } from '../files/workbook-password.ts'

export type SheetsPlanner = (bytes: Buffer, sheets: readonly { id: string; name: string }[], request: unknown, signal?: AbortSignal) => Promise<XlsxMutationPlan>
export type SheetsWorkbookPlanner = (bytes: Buffer, request: unknown, signal?: AbortSignal) => Promise<XlsxMutationPlan>
export type SheetsFollowUpPlan = (source: Buffer, edited: Buffer, signal?: AbortSignal) => Promise<XlsxMutationPlan | undefined>
export interface SheetsSaveNative {
  convertCsvImport?(input:Buffer,signal?:AbortSignal):Promise<Buffer>
  inspect(input: Uint8Array, signal?: AbortSignal): Promise<unknown>
  savePlan(input: Uint8Array, plan: XlsxMutationPlan, signal?: AbortSignal): Promise<{ bytes: Buffer }>
}
type SheetsRevisionInput = { baseRevision: string; leaseEpoch: number; editorId: string; unlockId?:string }
export type CsvSaveInput = Omit<SheetsRevisionInput,'unlockId'>
export interface SheetsSaveInput extends SheetsRevisionInput { request: unknown }
export interface SheetsPasswordInput extends SheetsRevisionInput { unlockId: string; newPassword: string }
export type SheetsExportInput = Omit<SheetsSaveInput, 'request'> & { phases: unknown[] }
export type SheetsCopyInput = SheetsExportInput & { name: string }
type PreparedWorkbook = Awaited<ReturnType<ReturnType<typeof createWorkbookPasswordCodec>['seal']>> & {rememberSave():void}

/** Prepare the normal T06 upload. The browser then commits it using the same
 * idempotent receipt/reconciliation protocol used by the other editors. */
export function createSheetsSaveService({ files, leases, revisions, native, plan, planFromWorkbook, planAfterSave, protectedWorkbooks, maxConcurrent = 2 }: {
  files: FileService; leases: LeaseService; revisions: RevisionService; native: SheetsSaveNative; plan: SheetsPlanner; planFromWorkbook?: SheetsWorkbookPlanner; planAfterSave?: SheetsFollowUpPlan; protectedWorkbooks?: Pick<ReturnType<typeof createSheetsService>,'openForProtectedSave'>; maxConcurrent?: number
}) {
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 8) throw new Error('Invalid sheets concurrency')
  let active = 0
  async function assertSource(token: string, fileId: string, input: SheetsRevisionInput, format: 'xlsx'|'csv'|'spreadsheet' = 'xlsx') {
    await leases.renewLease(token, fileId, { editorId: input.editorId, leaseEpoch: input.leaseEpoch })
    const head = await files.openFile(token, fileId)
    if (head.format !== format && !(format==='spreadsheet' && (head.format==='csv'||head.format==='xlsx'))) throw authError(415)
    if (head.file.revision !== input.baseRevision) throw authError(409)
    return head
  }
  async function planDraft(bytes: Buffer, request: unknown, signal?: AbortSignal) {
    // Resolve sheet identities from the actual input for this phase.
    if (planFromWorkbook) return planFromWorkbook(bytes, request, signal)
    const metadata = await native.inspect(bytes, signal) as { sheets: {id: string; name: string}[] }
    if (!metadata || !Array.isArray(metadata.sheets) || metadata.sheets.some(sheet => typeof sheet?.id !== 'string' || typeof sheet.name !== 'string')) throw new Error('Invalid workbook metadata')
    return plan(bytes, metadata.sheets, request, signal)
  }
  async function materializeDraft(bytes: Buffer, phases: unknown[], signal?: AbortSignal) {
    if (!Array.isArray(phases) || phases.length > 2) throw authError(400)
    for (const phase of phases) {
      signal?.throwIfAborted()
      const mutation = await planDraft(bytes, phase, signal)
      signal?.throwIfAborted()
      bytes = (await native.savePlan(bytes, mutation, signal)).bytes
    }
    if (bytes.length < 1 || bytes.length > 32 * 1024 * 1024) throw authError(413)
    return bytes
  }
  async function stageOutput(token:string,fileId:string,input:SheetsRevisionInput,output:Buffer,touchedEntries:string[],sealed?:PreparedWorkbook,signal?:AbortSignal){
    signal?.throwIfAborted()
    const draft={size:output.length,baseRevision:input.baseRevision,leaseEpoch:input.leaseEpoch,editorId:input.editorId}
    // The lease and base are checked again after encryption, then atomically at commit.
    const {uploadId}=sealed?await revisions.stageProtectedWorkbookUpload(token,fileId,draft):await revisions.stageUpload(token,fileId,draft)
    try{
      if(sealed)await files.receiveProtectedOfficeRevision(token,uploadId,sealed)
      else await files.receiveUpload(token,uploadId,output)
      signal?.throwIfAborted()
      await leases.renewLease(token,fileId,{editorId:input.editorId,leaseEpoch:input.leaseEpoch})
      signal?.throwIfAborted()
      sealed?.rememberSave()
      const sha256=sealed?.file.sha256??createHash('sha256').update(output).digest('hex')
      return {uploadId,touchedEntries,baseRevision:input.baseRevision,leaseEpoch:input.leaseEpoch,sha256,size:output.length}
    }catch(error){
      await files.cancelUpload(token,uploadId).catch(()=>{})
      throw error
    }
  }
  return {
    async prepareCsv(token: string, fileId: string, input: CsvSaveInput, bytes: Buffer, signal?: AbortSignal) {
      if (active >= maxConcurrent) throw Object.assign(authError(429), { retryAfter: 1 })
      if (bytes.length > MAX_OBJECT_BYTES) throw authError(413)
      // The renderer writes UTF-8 with BOM, including a BOM-only empty sheet.
      if (bytes.subarray(0,3).toString('hex') !== 'efbbbf') throw authError(400)
      active++
      try {
        signal?.throwIfAborted()
        await assertSource(token, fileId, input, 'csv')
        return await stageOutput(token, fileId, input, bytes, [], undefined, signal)
      } finally { active-- }
    },
    async exportDraft(token: string, fileId: string, input: SheetsExportInput, signal?: AbortSignal) {
      if (active >= maxConcurrent) throw Object.assign(authError(429), { retryAfter: 1 })
      active++
      try {
        signal?.throwIfAborted()
        const source=await assertSource(token, fileId, input, 'spreadsheet')
        if(source.workbookPasswordProtected)throw authError(423)
        const base = await files.readFile(token, fileId, input.baseRevision, signal)
        let workbook=base
        if(source.format==='csv'){
          if(!native.convertCsvImport)throw authError(415)
          workbook=await native.convertCsvImport(base,signal)
        }
        const bytes = await materializeDraft(workbook, input.phases, signal)
        await assertSource(token, fileId, input, 'spreadsheet')
        signal?.throwIfAborted()
        return bytes
      } finally { active-- }
    },
    async prepareProtectedCopy(token: string, fileId: string, input: SheetsCopyInput, signal?: AbortSignal) {
      if (token.startsWith('dsh-edit:')) throw authError(404)
      if (!protectedWorkbooks || !input.unlockId) throw authError(423)
      if (validateFileName(input.name) !== 'xlsx') throw authError(415)
      if (active >= maxConcurrent) throw Object.assign(authError(429), {retryAfter:1})
      active++
      try {
        signal?.throwIfAborted()
        const head = await assertSource(token, fileId, input)
        if (!head.workbookPasswordProtected || head.officeSignatureProtected) throw authError(423)
        const protection = await protectedWorkbooks.openForProtectedSave(token,fileId,input.baseRevision,input.unlockId,signal)
        const bytes = await materializeDraft(protection.bytes,input.phases,signal)
        const sealed = await protection.seal(bytes)
        await assertSource(token,fileId,input)
        protection.check()
        const {uploadId}=await files.stageUpload(token,{name:input.name,size:sealed.bytes.length})
        try {
          await files.receiveProtectedOfficeRevision(token,uploadId,sealed)
          await assertSource(token,fileId,input)
          protection.check()
          return {uploadId}
        } catch(error) {
          await files.cancelUpload(token,uploadId).catch(()=>{})
          throw error
        }
      } finally { active-- }
    },
    async prepare(token: string, fileId: string, input: SheetsSaveInput, signal?: AbortSignal) {
      if (active >= maxConcurrent) throw Object.assign(authError(429), { retryAfter: 1 })
      active++
      try {
        signal?.throwIfAborted()
        const head=await assertSource(token, fileId, input)
        if(head.workbookPasswordProtected&&(!protectedWorkbooks||!input.unlockId))throw authError(423)
        const protection=head.workbookPasswordProtected&&input.unlockId
          ? await protectedWorkbooks!.openForProtectedSave(token,fileId,input.baseRevision,input.unlockId,signal) : undefined
        const bytes = protection?.bytes ?? await files.readFile(token, fileId, input.baseRevision, signal)
        signal?.throwIfAborted()
        const mutation = await planDraft(bytes, input.request, signal)
        signal?.throwIfAborted()
        let saved = await native.savePlan(bytes, mutation, signal)
        signal?.throwIfAborted()
        const followUp = await planAfterSave?.(bytes, saved.bytes, signal)
        if (followUp) saved = await native.savePlan(saved.bytes, followUp, signal)
        signal?.throwIfAborted()
        const sealed=await protection?.seal(saved.bytes)
        const touchedEntries = [...new Set([mutation, ...(followUp ? [followUp] : [])].flatMap(plan =>
          [...plan.replaced.keys(), ...plan.added.keys(), ...plan.addedBinary.keys(), ...plan.removedEntries],
        ))]
        return await stageOutput(token,fileId,input,sealed?.bytes??saved.bytes,touchedEntries,sealed,signal)
      } finally { active-- }
    },
    async preparePassword(token:string,fileId:string,input:SheetsPasswordInput,signal?:AbortSignal){
      if(token.startsWith('dsh-edit:'))throw authError(404)
      if(!protectedWorkbooks||!input.unlockId)throw authError(423)
      if(typeof input.newPassword!=='string'||!input.newPassword.length||input.newPassword.length>255)throw authError(400)
      if(active>=maxConcurrent)throw Object.assign(authError(429),{retryAfter:1})
      active++
      try{
        signal?.throwIfAborted()
        const head=await assertSource(token,fileId,input)
        if(!head.workbookPasswordProtected||head.officeSignatureProtected)throw authError(423)
        const protection=await protectedWorkbooks.openForProtectedSave(token,fileId,input.baseRevision,input.unlockId,signal)
        const sealed=await protection.seal(protection.bytes,input.newPassword)
        return await stageOutput(token,fileId,input,sealed.bytes,[],sealed,signal)
      }finally{active--}
    },
  }
}

