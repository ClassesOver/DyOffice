import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { restrictedFixture } from './restricted.mjs'
import { createLocalObjectStore } from '../../server/src/storage/local-dev.ts'

export async function fileFixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dyoffice-files-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const baseObjects = options.objectStore ?? await createLocalObjectStore({ directory })
  const objects = options.wrapObjects ? options.wrapObjects(baseObjects) : baseObjects
  const f = await restrictedFixture(t, { ...options, objectStore: objects, businessMax: 4 })
  const { createFileService } = await import('../../server/src/modules/files/service.ts')
  return { ...f, objects, directory, files: createFileService({ transactions: f.transactions, objects, ...options.filePolicy }) }
}
export const docxBytes = () => readFile(new URL('../../../../packages/docx-engine/tests/fixtures/truths/render-sectafter-no-blank/probe.docx', import.meta.url))
export async function importFile(f, token, bytes, name = 'report.docx') {
  const upload = await f.files.stageUpload(token, { name, size: bytes.length })
  await f.files.receiveUpload(token, upload.uploadId, bytes)
  return f.files.finishUpload(token, upload.uploadId)
}
