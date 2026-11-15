import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { S3Client, CreateBucketCommand, PutObjectCommand, DeleteObjectsCommand, ListObjectsV2Command, DeleteBucketCommand } from '@aws-sdk/client-s3'
import { createS3ObjectStore } from '../../server/src/storage/s3.ts'

export async function s3Fixture(t) {
  const endpoint = process.env.DYOFFICE_TEST_S3_ENDPOINT
  assert.ok(endpoint, 'Real disposable S3-compatible service required')
  const url = new URL(endpoint)
  assert.ok(['127.0.0.1','localhost'].includes(url.hostname), 'Tests only access a loopback S3 service')
  const client = new S3Client({ endpoint, region: 'us-east-1', forcePathStyle: true, credentials: { accessKeyId: process.env.DYOFFICE_TEST_S3_ACCESS_KEY, secretAccessKey: process.env.DYOFFICE_TEST_S3_SECRET_KEY } })
  const bucket = 'dyoffice-test-' + randomUUID()
  try { await client.send(new CreateBucketCommand({ Bucket: bucket })) } catch (error) { client.destroy(); throw error }
  t.after(async () => {
    try {
      const { Contents = [] } = await client.send(new ListObjectsV2Command({ Bucket: bucket }))
      if (Contents.length) await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: Contents.map(({ Key }) => ({ Key })) } }))
      await client.send(new DeleteBucketCommand({ Bucket: bucket }))
    } finally { client.destroy() }
  })
  return { store: createS3ObjectStore({ client, bucket }), client, bucket, corrupt: (Key, Body) => client.send(new PutObjectCommand({ Bucket: bucket, Key, Body })) }
}
