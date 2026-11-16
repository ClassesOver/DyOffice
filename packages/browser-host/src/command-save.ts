import type { BrowserHost } from '../../web-contracts/src/host.ts'
import { isRevisionRef, type SaveInput, type RevisionRef } from '../../web-contracts/src/api.ts'
import type { CommandEnvelope } from '../../web-contracts/src/tools.ts'
import type { EditorCommandState } from './tool-executor.ts'
export interface CommandSaveBinding {
  commandId: string
  fileId: string
  digest: string
  uploadId: string
  sha256: string
  size: number
  idempotencyKey: string
}
/** Retains the exact tuple across ambiguous bind/commit replies. It never retries
 * editor application. The caller must preserve newer dirty editor generations. */
export function createCommandSaveCoordinator({
  host,
  current,
  serialize,
  bind,
  verifyCommitted,
}: {
  host: Pick<BrowserHost, 'stageSave' | 'commitSave'> & {
    reconcile: (fileId: string) => Promise<RevisionRef>
  }
  current: () => EditorCommandState
  serialize: () => Promise<Uint8Array>
  bind: (binding: CommandSaveBinding) => Promise<unknown>
  verifyCommitted: (
    envelope: CommandEnvelope,
    revision: RevisionRef,
    digest: string,
  ) => Promise<boolean>
}) {
  if (typeof verifyCommitted !== 'function') throw Error('Durable command verifier required')
  let busy = false,
    disposed = false
  let pending:
    | {
        envelope: CommandEnvelope
        input: SaveInput
        binding: CommandSaveBinding
        bound: boolean
        attempted: boolean
      }
    | undefined
  function matches(e: CommandEnvelope, g: number) {
    const s = current()
    return (
      !disposed &&
      s.fileId === e.fileId &&
      s.baseRevision === e.baseRevision &&
      s.leaseEpoch === e.leaseEpoch &&
      s.editorGeneration === g
    )
  }
  async function finish() {
    if (disposed || !pending) throw Error('No active pending save')
    const p = pending
    if (!p.bound) {
      await bind({ ...p.binding })
      p.bound = true
    }
    if (disposed) throw Error('Disposed; reconcile journal before further edits')
    const retry = p.attempted
    p.attempted = true
    const r = await (retry ? host.reconcile(p.input.fileId) : host.commitSave(p.input))
    if (disposed) throw Error('Disposed during commit; query durable outcome')
    if (
      !isRevisionRef(r) ||
      r.fileId !== p.input.fileId ||
      r.revision === p.input.baseRevision ||
      r.sha256 !== p.binding.sha256 ||
      r.size !== p.binding.size
    )
      throw Error('Invalid command save receipt')
    if ((await verifyCommitted(structuredClone(p.envelope), r, p.binding.digest)) !== true)
      throw Error('No durable command receipt')
    if (disposed) throw Error('Disposed during receipt verification')
    pending = undefined
    return r
  }
  return {
    async save(input: CommandEnvelope, digest: string, appliedGeneration: number) {
      if (disposed || busy || pending) throw Error('Save busy or reconciliation required')
      const e = structuredClone(input)
      if (
        !Number.isSafeInteger(appliedGeneration) ||
        appliedGeneration <= e.editorGeneration ||
        !matches(e, appliedGeneration)
      )
        throw Error('Stale command snapshot')
      busy = true
      try {
        const bytes = new Uint8Array(await serialize())
        const sha256 = Array.from(
          new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.buffer as ArrayBuffer)),
          (n) => n.toString(16).padStart(2, '0'),
        ).join('')
        if (!matches(e, appliedGeneration)) throw Error('Editor changed during serialization')
        const { uploadId } = await host.stageSave(bytes, e.fileId)
        if (!matches(e, appliedGeneration)) throw Error('Editor changed during staging')
        const idempotencyKey = crypto.randomUUID()
        pending = {
          envelope: e,
          bound: false,
          attempted: false,
          input: Object.freeze({
            fileId: e.fileId,
            uploadId,
            baseRevision: e.baseRevision,
            leaseEpoch: e.leaseEpoch,
            idempotencyKey,
            sourceCommandId: e.commandId,
          }),
          binding: Object.freeze({
            commandId: e.commandId,
            fileId: e.fileId,
            digest,
            uploadId,
            sha256,
            size: bytes.byteLength,
            idempotencyKey,
          }),
        }
        return await finish()
      } finally {
        busy = false
      }
    },
    async reconcile() {
      if (disposed || busy) throw Error('Save busy or disposed')
      busy = true
      try {
        return await finish()
      } finally {
        busy = false
      }
    },
    hasPending() {
      return !!pending
    },
    dispose() {
      disposed = true
    },
  }
}
