import { fileFixture, docxBytes, importFile } from './files.mjs'
export async function jobFixture(t,{ jobPolicy = {},workerPolicy = {},...options } = {}) {
  const f = await fileFixture(t,{ ...options,worker: true })
  const imported = await importFile(f,f.alice.token,await docxBytes(),'job-input.docx')
  const { createJobService } = await import('../../server/src/modules/jobs/service.ts')
  const { createJobWorkerStore } = await import('../../server/src/modules/jobs/worker-store.ts')
  return { ...f,
    jobs: createJobService({ transactions: f.transactions,enabledTypes: ['docx.roundtrip'],...jobPolicy }),
    worker: createJobWorkerStore({ pool: f.workerPool,deploymentId: f.deploymentId,...workerPolicy }),
    input: { artifactId: imported.file.revision },fileId: imported.file.fileId,
  }
}
