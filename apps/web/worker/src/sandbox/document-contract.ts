import { DocumentContractError, getDocumentProfile, type ProfileId } from './document-profiles.ts'

/** Syntax validation only. All identities/digests must come from trusted control-plane state.
 * This function cannot authorize a tenant, verify bytes, grant a lease, or enable production.
 */
export interface DocumentExecutionRequest {
  readonly protocolVersion: 1
  readonly deploymentId: string
  readonly tenantId: string
  readonly actorId: string
  readonly sessionBindingDigest: string
  readonly fileId: string
  readonly editorId: string
  readonly leaseEpoch: number
  readonly baseRevision: string
  readonly generation: number
  readonly jobId: string
  readonly attempt: number
  readonly jobEpoch: number
  readonly inputSha256: string
  readonly inputSize: number
  readonly profileId: ProfileId
  readonly runtimeDigest: string
  readonly policyVersion: 1
  readonly deadlineAt: string
}
const identities = ['deploymentId','tenantId','actorId','fileId','editorId','baseRevision','jobId'] as const
const digests = ['sessionBindingDigest','inputSha256','runtimeDigest'] as const
const positiveIntegers = ['leaseEpoch','attempt','jobEpoch','inputSize','policyVersion'] as const
const keys = ['protocolVersion',...identities,...digests,...positiveIntegers,'generation','profileId','deadlineAt'] as const
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const sha256 = /^[0-9a-f]{64}$/
function invalid(code = 'INVALID_DOCUMENT_REQUEST'): never { throw new DocumentContractError(code) }
export function validateDocumentExecutionRequest(value: unknown, now: Date): DocumentExecutionRequest {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) invalid('INVALID_DOCUMENT_CLOCK')
  if (!value || typeof value !== 'object' || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) invalid()
  // No coercion, getters, inherited fields, symbols or hidden extensions at the wire boundary.
  const names = Reflect.ownKeys(value)
  if (names.length !== keys.length || names.some(key => typeof key !== 'string' || !(keys as readonly string[]).includes(key))) invalid()
  const data: Record<string, unknown> = Object.create(null)
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value,key)
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) invalid()
    data[key] = descriptor.value
  }
  if (data.protocolVersion !== 1) invalid()
  for (const key of identities) {
    if (typeof data[key] !== 'string' || !uuid.test(data[key])) invalid()
    data[key] = data[key].toLowerCase()
  }
  for (const key of digests) if (typeof data[key] !== 'string' || !sha256.test(data[key])) invalid()
  for (const key of positiveIntegers) if (!Number.isSafeInteger(data[key]) || (data[key] as number) < 1) invalid()
  if (!Number.isSafeInteger(data.generation) || (data.generation as number) < 0) invalid()
  const profile = getDocumentProfile(data.profileId)
  if (data.policyVersion !== profile.policyVersion) invalid('DOCUMENT_POLICY_UNSUPPORTED')
  if ((data.inputSize as number) > profile.inputBytes) invalid('DOCUMENT_INPUT_LIMIT')
  if (typeof data.deadlineAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(data.deadlineAt)) invalid()
  const deadline = Date.parse(data.deadlineAt)
  if (!Number.isFinite(deadline) || new Date(deadline).toISOString() !== data.deadlineAt) invalid()
  const remaining = deadline - now.getTime()
  if (remaining <= 0) invalid('DOCUMENT_DEADLINE_EXPIRED')
  if (remaining > profile.wallMs) invalid('DOCUMENT_DEADLINE_LIMIT')
  return Object.freeze({...data}) as unknown as DocumentExecutionRequest
}
