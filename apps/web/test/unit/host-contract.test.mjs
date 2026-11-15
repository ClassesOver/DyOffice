import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBrowserHost } from '../../../../packages/browser-host/src/index.ts'
import { HostError } from '../../../../packages/web-contracts/src/errors.ts'
import { decodeHostEvent, MAX_HOST_EVENT_BYTES } from '../../../../packages/web-contracts/src/events.ts'

const sha256 = 'a'.repeat(64)
const validRevision = { fileId:'file-a', revision:'revision-1', sha256, size:10 }
const validSave = { fileId:'file-a', uploadId:'upload-a', baseRevision:'revision-0', idempotencyKey:'key-1', leaseEpoch:0 }

test('missing Web bridge never claims edit support or successful operations', async () => {
  const host = createBrowserHost()
  assert.deepEqual(await host.getCapabilities(), { docx:'unsupported', xlsx:'unsupported', pptx:'unsupported', pdf:'unsupported' })
  await assert.rejects(host.open('file-a'), err => err instanceof HostError && err.code === 'UNSUPPORTED')
  await assert.rejects(host.commitSave(validSave), err => err.code === 'UNSUPPORTED')
})

test('invalid revisions are rejected before invoking adapter', async () => {
  let calls = 0
  const host = createBrowserHost({ commitSave: async () => { calls++; return validRevision } })
  await assert.rejects(host.commitSave({ ...validSave, baseRevision:'' }), err => err.code === 'INVALID_REVISION')
  await assert.rejects(host.commitSave({ ...validSave, leaseEpoch:-1 }), err => err.code === 'INVALID_REVISION')
  assert.equal(calls, 0)
  assert.deepEqual(await host.commitSave(validSave), validRevision)
})

test('invalid or cross-file responses fail closed', async () => {
  const host = createBrowserHost({
    open: async () => ({ file:{ ...validRevision, revision:'' }, format:'docx', downloadEndpoint:'/a', capabilities:{ docx:'editable',xlsx:'read_only',pptx:'read_only',pdf:'read_only' } }),
    commitSave: async () => ({ ...validRevision, fileId:'other-user-file' })
  })
  await assert.rejects(host.open('file-a'), err => err.code === 'INVALID_RESPONSE')
  await assert.rejects(host.commitSave(validSave), err => err.code === 'INVALID_RESPONSE')
})

test('preferences response excludes secrets and extra server fields', async () => {
  const host = createBrowserHost({ getPreferences: async () => ({theme:'dark',language:'zh',apiKey:'never-export',admin:{ secret:'x' }}) })
  assert.deepEqual(await host.getPreferences(), { theme:'dark',language:'zh' })
})

test('stream event parser rejects oversized events, stale protocol, and malformed envelopes', () => {
  const good = { protocolVersion:1, messageId:'m1', sessionId:'s1', fileId:'f1',type:'editor.ready',payload:{} }
  assert.deepEqual(decodeHostEvent(JSON.stringify(good)), good)
  assert.throws(() => decodeHostEvent(JSON.stringify({...good,protocolVersion:0})), err => err.code === 'INVALID_RESPONSE')
  assert.throws(() => decodeHostEvent(JSON.stringify({...good,fileId:''})), err => err.code === 'INVALID_RESPONSE')
  assert.throws(() => decodeHostEvent(' '.repeat(MAX_HOST_EVENT_BYTES+1)), err => err.code === 'PAYLOAD_TOO_LARGE')
})

test('advertised editable capability is not allowed without a working byte and save adapter', async () => {
  const advertised = { docx:'editable', xlsx:'read_only', pptx:'unsupported', pdf:'unsupported' }
  const host = createBrowserHost({ getCapabilities:async()=>advertised })
  assert.deepEqual(await host.getCapabilities(), {docx:'unsupported',xlsx:'unsupported',pptx:'unsupported',pdf:'unsupported'})
  const partial = createBrowserHost({
    getCapabilities:async()=>advertised,
    open:async()=>({file:validRevision,format:'docx',downloadEndpoint:'/api/files/file-a',capabilities:advertised}),
    readBytes:async()=>new Uint8Array([1]),
  })
  assert.deepEqual(await partial.getCapabilities(), {docx:'read_only',xlsx:'read_only',pptx:'unsupported',pdf:'unsupported'})
  assert.equal((await partial.open('file-a')).capabilities.docx,'read_only')
})

test('invalid typed preference values are rejected rather than exposed as trusted settings', async () => {
  const host = createBrowserHost({getPreferences:async()=>({theme:'dark',language:'zh',authorName:{apiKey:'secret'},autoSave:'true'})})
  await assert.rejects(host.getPreferences(), err=>err.code==='INVALID_RESPONSE')
})

test('open and commit responses are reduced to contract fields', async () => {
  const caps = { docx:'read_only', xlsx:'read_only', pptx:'read_only', pdf:'read_only' }
  const host = createBrowserHost({
    open: async () => ({ file:{ ...validRevision, ownerId:'user-b', storageKey:'s3://bucket/x' }, format:'docx', downloadEndpoint:'/api/v1/files/file-a/content', capabilities:caps, signedUrlSecret:'x' }),
    readBytes: async () => new Uint8Array([1]),
    commitSave: async () => ({ ...validRevision, storageKey:'s3://bucket/x' }),
  })
  assert.deepEqual(await host.open('file-a'), { file:validRevision, format:'docx', downloadEndpoint:'/api/v1/files/file-a/content', capabilities:caps })
  assert.deepEqual(await host.commitSave(validSave), validRevision)
})

test('download endpoints must be same-origin paths', async () => {
  const caps = { docx:'read_only', xlsx:'read_only', pptx:'read_only', pdf:'read_only' }
  for (const downloadEndpoint of ['', 'https://evil.example/f', '//evil.example/f', 'javascript:alert(1)', 'api/files', '/\\evil.example', '/a b']) {
    const host = createBrowserHost({ open: async () => ({ file:validRevision, format:'docx', downloadEndpoint, capabilities:caps }) })
    await assert.rejects(host.open('file-a'), err => err.code === 'INVALID_RESPONSE', downloadEndpoint)
  }
})

test('commitSave forwards only SaveInput fields, never caller-supplied identity', async () => {
  let seen
  const host = createBrowserHost({ commitSave: async (input) => { seen = input; return validRevision } })
  await host.commitSave({ ...validSave, ownerId:'user-b', deploymentId:'other', sourceCommandId:'cmd-1' })
  assert.deepEqual(seen, { ...validSave, sourceCommandId:'cmd-1' })
})
