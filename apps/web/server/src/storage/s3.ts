import { GetObjectCommand, PutObjectCommand, HeadBucketCommand, type S3Client } from '@aws-sdk/client-s3'
import { Readable } from 'node:stream'
import { assertObjectReference, collectVerified, verifyStream, objectReference, storageError, type ObjectRef, type ObjectStore } from './object-store.ts'

// The caller owns client lifecycle and credentials. The bucket must be private,
// precreated and dedicated; no public or presigned download URL is issued here.
export function createS3ObjectStore({ client, bucket }: { client: S3Client; bucket: string }): ObjectStore {
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw storageError(400)
  async function read<T>(reference: ObjectRef, consume: (source: AsyncIterable<Uint8Array>, reference: ObjectRef) => Promise<T>): Promise<T> {
    assertObjectReference(reference)
    let body: Readable | undefined
    try {
      const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: reference.key }), { abortSignal: AbortSignal.timeout(30_000) })
      if (!(result.Body instanceof Readable)) throw storageError()
      body = result.Body
      if (result.ContentLength !== reference.size) throw storageError()
      // Never trust ETag or stored user metadata as a content hash.
      return await consume(body, reference)
    } catch { throw storageError() }
    finally { body?.destroy() }
  }
  return {
    async checkReady() {
      try { await client.send(new HeadBucketCommand({ Bucket: bucket }), { abortSignal: AbortSignal.timeout(5000) }) }
      catch { throw storageError() }
    },
    async putImmutable(key, bytes) {
      const reference = objectReference(key, bytes)
      bytes = Buffer.from(bytes)
      try {
        await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes, ContentLength: reference.size,
          ContentType: 'application/octet-stream', IfNoneMatch: '*', ChecksumSHA256: Buffer.from(reference.sha256, 'hex').toString('base64'),
        }), { abortSignal: AbortSignal.timeout(30_000) })
        return reference
      } catch (error) {
        const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
        if (status === 409 || status === 412) throw storageError(409)
        throw storageError()
      }
    },
    readVerified: reference => read(reference, collectVerified),
    verifyObject: reference => read(reference, verifyStream),
  }
}
