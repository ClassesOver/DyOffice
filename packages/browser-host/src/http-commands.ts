import { isRevisionRef, type RevisionRef } from '../../web-contracts/src/api.ts'
import { sameCommandJson } from './command-equality.ts'
import type { CommandEnvelope } from '../../web-contracts/src/tools.ts'
import type { CommandSaveBinding } from './command-save.ts'
export interface HttpCommandRecord {
  envelope: CommandEnvelope
  digest: string
  state: string
  claimId?: string
  appliedGeneration?: number
  revision?: RevisionRef
}
/** Same-origin transport. Instantiate in trusted UI composition, not inside a
 * provider adapter. No automatic approval, dispatch or retry on network failure. */
export function createHttpCommandClient({
  editorId,
  currentGeneration,
  getCsrfToken,
  fetchImpl = fetch,
}: {
  editorId: string
  currentGeneration: () => number
  getCsrfToken: () => Promise<string>
  fetchImpl?: typeof fetch
}) {
  let disposed = false
  async function request(
    action: string,
    envelope: CommandEnvelope,
    extra: Record<string, unknown> = {},
    expectedDigest?: string,
  ): Promise<HttpCommandRecord> {
    if (disposed) throw Error('Command client disposed')
    const snapshot = structuredClone(envelope),
      generation = currentGeneration(),
      csrf = await getCsrfToken()
    if (disposed || generation !== currentGeneration())
      throw Error('Editor changed while preparing command request')
    const response = await fetchImpl('/api/v1/commands/' + action, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: JSON.stringify({
        editorId,
        currentGeneration: generation,
        envelope: snapshot,
        ...extra,
      }),
    })
    if (
      disposed ||
      !response.ok ||
      !response.headers.get('content-type')?.includes('application/json')
    )
      throw Error('Command request unconfirmed')
    const text = await response.text()
    if (disposed) throw Error('Command client disposed')
    if (text.length > 140000) throw Error('Command response too large')
    const r = JSON.parse(text)
    if (action === 'bind') {
      if (r?.bound !== true) throw Error('Invalid save binding')
      return r
    }
    if (
      !r ||
      !sameCommandJson(r.envelope, snapshot) ||
      typeof r.digest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(r.digest) ||
      (expectedDigest !== undefined && r.digest !== expectedDigest) ||
      ![
        'pending_approval',
        'approved',
        'unknown_outcome',
        'applied_uncommitted',
        'committed',
        'cancelled',
      ].includes(r.state)
    )
      throw Error('Invalid command response')
    if (
      ['execute', 'undo'].includes(action) &&
      (!/^[a-f0-9-]{36}$/.test(r.claimId ?? '') || r.state !== 'unknown_outcome')
    )
      throw Error('Invalid execution claim')
    return r
  }
  return {
    proposeCommand: (e: CommandEnvelope) => request('propose', e),
    approveCommand: (e: CommandEnvelope, digest: string) =>
      request('approve', e, { digest }, digest),
    beginExecution: (e: CommandEnvelope, digest: string) =>
      request('execute', e, { digest }, digest) as Promise<HttpCommandRecord & { claimId: string }>,
    reportApplied: (e: CommandEnvelope, claimId: string, generation: number) =>
      request('applied', e, { claimId, generation }),
    getCommandOutcome: (e: CommandEnvelope) => request('outcome', e),
    cancelCommand: (e: CommandEnvelope) => request('cancel', e),
    beginUndo: (e: CommandEnvelope) =>
      request('undo', e) as Promise<HttpCommandRecord & { claimId: string }>,
    reportUndone: (e: CommandEnvelope, claimId: string) => request('undone', e, { claimId }),
    bindCommandUpload: (e: CommandEnvelope, b: CommandSaveBinding) => {
      if (e.commandId !== b.commandId || e.fileId !== b.fileId)
        return Promise.reject(Error('Binding identity mismatch'))
      const { commandId: _, fileId: __, ...extra } = b
      return request('bind', e, extra)
    },
    async verifyCommitted(e: CommandEnvelope, revision: RevisionRef, digest: string) {
      const row = await request('outcome', e, {}, digest)
      return (
        row.state === 'committed' &&
        isRevisionRef(row.revision) &&
        sameCommandJson(row.revision, revision)
      )
    },
    dispose() {
      disposed = true
    },
  }
}
