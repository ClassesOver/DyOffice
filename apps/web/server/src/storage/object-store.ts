import { createHash } from 'node:crypto'

export const MAX_OBJECT_BYTES = 32 * 1024 * 1024
export interface ObjectRef { readonly key: string; readonly size: number; readonly sha256: string }
export interface ObjectStore {
  putImmutable(key: string, bytes: Buffer): Promise<ObjectRef>
  readVerified(reference: ObjectRef): Promise<Buffer>
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
export function objectReference(key: string, bytes: Buffer): ObjectRef {
  assertObjectKey(key)
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MAX_OBJECT_BYTES) throw storageError(400)
  return Object.freeze({ key, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
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
