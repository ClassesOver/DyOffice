import { test } from 'node:test'
import assert from 'node:assert/strict'
import { authorizationHeader } from '../server/src/storage/s3-http.mjs'

test('SigV4 matches the published Amazon S3 GET example', () => {
  const header = authorizationHeader({
    method: 'GET',
    path: '/test.txt',
    query: '',
    headers: {
      host: 'examplebucket.s3.amazonaws.com',
      range: 'bytes=0-9',
      'x-amz-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      'x-amz-date': '20130524T000000Z',
    },
    body: Buffer.alloc(0),
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    region: 'us-east-1',
    amzDate: '20130524T000000Z',
  })
  assert.match(header, /Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41/)
})
