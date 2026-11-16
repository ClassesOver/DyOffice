import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { PutBucketVersioningCommand, ListObjectVersionsCommand, DeleteObjectsCommand } from '@aws-sdk/client-s3'
import { s3Fixture } from '../helpers/s3.mjs'
const key=()=>`${randomUUID()}/${randomUUID()}/objects/${randomUUID()}`
test('real S3 unversioned physical removal is idempotent and leaves no readable object',async t=>{
 const {store}=await s3Fixture(t),ref=await store.putImmutable(key(),Buffer.from('orphan'))
 await store.removeUnreferenced(ref.key);await store.removeUnreferenced(ref.key)
 await assert.rejects(()=>store.readVerified(ref),{statusCode:503})
})
test('real S3 enabled and suspended versioning rejects quota reclamation and preserves data',async t=>{
 const {store,client,bucket}=await s3Fixture(t)
 try{
  await client.send(new PutBucketVersioningCommand({Bucket:bucket,VersioningConfiguration:{Status:'Enabled'}}))
  const ref=await store.putImmutable(key(),Buffer.from('retained'))
  await assert.rejects(()=>store.removeUnreferenced(ref.key),{statusCode:503})
  assert.deepEqual(await store.readVerified(ref),Buffer.from('retained'))
  await client.send(new PutBucketVersioningCommand({Bucket:bucket,VersioningConfiguration:{Status:'Suspended'}}))
  await assert.rejects(()=>store.removeUnreferenced(ref.key),{statusCode:503})
  assert.deepEqual(await store.readVerified(ref),Buffer.from('retained'))
 }finally{
  const result=await client.send(new ListObjectVersionsCommand({Bucket:bucket}))
  const Objects=[...(result.Versions??[]),...(result.DeleteMarkers??[])].map(({Key,VersionId})=>({Key,VersionId}))
  if(Objects.length)await client.send(new DeleteObjectsCommand({Bucket:bucket,Delete:{Objects}}))
 }
})
