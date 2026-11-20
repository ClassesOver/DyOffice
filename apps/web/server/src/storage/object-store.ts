import { createHash } from 'node:crypto'

export const MAX_OBJECT_BYTES = 32 * 1024 * 1024
export interface ObjectRef { readonly key: string; readonly size: number; readonly sha256: string }
export interface ObjectStore {
  // Custom stores without a read-only probe remain unavailable to readiness.
  checkReady?(): Promise<void>
  /** Optional metadata is an assertion, never a trusted substitute for hashing
   *  and bounding the actual private byte snapshot before publication. */
  putImmutable(key: string, bytes: Buffer, expected?: { size: number; sha256: string }): Promise<ObjectRef>
  readVerified(reference: ObjectRef, signal?: AbortSignal): Promise<Buffer>
  // Internal only: caller must prove terminal publication and no live references.
  // Missing objects succeed; adapters unable to physically reclaim must reject.
  removeUnreferenced?(key: string): Promise<void>
  verifyObject(reference: ObjectRef): Promise<void>
}
export function storageError(statusCode = 503): Error & { statusCode: number } {
  return Object.assign(new Error('Object storage operation rejected'), { statusCode })
}
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const namespace = new RegExp(`^${uuid}/${uuid}/objects/${uuid}$`)
export function assertObjectKey(key: string) {
  if (typeof key !== 'string' || !namespace.test(key)) throw storageError(400)
}
function assertObjectBytes(key: string, bytes: Buffer) {
  assertObjectKey(key)
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MAX_OBJECT_BYTES) throw storageError(400)
}
export function objectReference(key: string, bytes: Buffer): ObjectRef {
  assertObjectBytes(key, bytes)
  return Object.freeze({ key, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
}
export function snapshotObject(key: string, input: Buffer, expected?: { size: number; sha256: string }) {
  // Bound before allocating and hash the same owned bytes handed to storage.
  assertObjectBytes(key, input)
  const bytes = Buffer.from(input), reference = objectReference(key, bytes)
  if (expected !== undefined) {
    assertObjectReference({ key, size: expected?.size, sha256: expected?.sha256 })
    if (expected.size !== reference.size || expected.sha256 !== reference.sha256) throw storageError(400)
  }
  return { bytes, reference }
}
export function assertObjectReference(ref: ObjectRef) {
  if (!ref || typeof ref !== 'object') throw storageError(400)
  assertObjectKey(ref.key)
  if (!Number.isSafeInteger(ref.size) || ref.size < 1 || ref.size > MAX_OBJECT_BYTES || typeof ref.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(ref.sha256)) throw storageError(400)
}
export async function collectVerified(source: AsyncIterable<Uint8Array>, reference: ObjectRef): Promise<Buffer> {
  const chunks: Buffer[] = []
  await verifyStream(source, reference, bytes => chunks.push(Buffer.from(bytes)))
  return Buffer.concat(chunks, reference.size)
}

// Hash each borrowed chunk synchronously before advancing the source. The
// verification-only path never retains payload chunks or allocates a full object.
export async function verifyStream(source: AsyncIterable<Uint8Array>, reference: ObjectRef, collect?: (bytes: Uint8Array) => void): Promise<void> {
  assertObjectReference(reference)
  const hash = createHash('sha256')
  let size = 0
  for await (const chunk of source) {
    size += chunk.byteLength
    if (size > reference.size) throw storageError()
    hash.update(chunk)
    collect?.(chunk)
  }
  if (size !== reference.size || hash.digest('hex') !== reference.sha256) throw storageError()
}
