import { S3Client, HeadBucketCommand } from '@aws-sdk/client-s3'
import { createLocalObjectStore } from './local-dev.ts'
import { createS3ObjectStore } from './s3.ts'
import type { ObjectStore } from './object-store.ts'
import type { FilePolicy } from '../modules/files/service.ts'

export async function configuredObjectStore(environment: NodeJS.ProcessEnv): Promise<{ objectStore?: ObjectStore; filePolicy?: FilePolicy; close: () => void }> {
  if (!environment.DYOFFICE_FILE_API && !environment.DYOFFICE_OBJECT_STORE) return { close() {} }
  if (environment.DYOFFICE_FILE_API !== undefined && environment.DYOFFICE_FILE_API !== 'experimental') throw new Error('Invalid file API configuration')
  const quota = environment.DYOFFICE_FILE_QUOTA_BYTES
  if (quota !== undefined && (!/^[1-9][0-9]*$/.test(quota) || !Number.isSafeInteger(Number(quota)))) throw new Error('Invalid file quota')
  const filePolicy = quota === undefined ? undefined : { quotaBytes: Number(quota) }
  if (environment.DYOFFICE_OBJECT_STORE === 'local-dev') {
    if (!environment.DYOFFICE_OBJECT_DIRECTORY) throw new Error('Explicit development object directory required')
    return { objectStore: await createLocalObjectStore({ directory: environment.DYOFFICE_OBJECT_DIRECTORY }), filePolicy, close() {} }
  }
  if (environment.DYOFFICE_OBJECT_STORE !== 's3' || !environment.DYOFFICE_S3_BUCKET || !environment.DYOFFICE_S3_REGION) throw new Error('Explicit S3 configuration required')
  const endpoint = environment.DYOFFICE_S3_ENDPOINT
  if (endpoint) {
    const url = new URL(endpoint)
    if (url.username || url.password || url.search || url.hash || !['https:','http:'].includes(url.protocol) || (url.protocol === 'http:' && !['127.0.0.1','localhost','[::1]'].includes(url.hostname))) throw new Error('S3 endpoint requires TLS outside loopback')
  }
  const pathStyle = environment.DYOFFICE_S3_FORCE_PATH_STYLE
  if (pathStyle !== undefined && !['true','false'].includes(pathStyle)) throw new Error('Invalid S3 path style')
  const client = new S3Client({ region: environment.DYOFFICE_S3_REGION, endpoint, forcePathStyle: pathStyle === 'true' })
  try {
    const objectStore = createS3ObjectStore({ client, bucket: environment.DYOFFICE_S3_BUCKET })
    await client.send(new HeadBucketCommand({ Bucket: environment.DYOFFICE_S3_BUCKET }), { abortSignal: AbortSignal.timeout(5000) })
    return { objectStore, filePolicy, close: () => client.destroy() }
  } catch (error) { client.destroy(); throw error }
}
