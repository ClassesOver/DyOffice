import { join } from 'node:path'
import { createOutboxService } from '../../outbox/service.mjs'
import { createLeaseService } from '../leases/service.mjs'
import { createFileJournal } from './journal.mjs'
import { createRevisionService } from './service.mjs'

/**
 * Development principal for the personal bearer token. The request boundary
 * already accepted that token. Callers must not take owner, deployment, or
 * session from the request body. This is not a database session and not RLS.
 */
export const DEV_PERSONAL_PRINCIPAL = Object.freeze({
  ownerId: 'personal',
  deploymentId: 'dev',
  sessionId: 'dev-personal',
})

export async function createRevisionRuntime({ directory, objects, now, leaseTtlMs } = {}) {
  if (!directory || !objects) throw new TypeError('revision runtime requires a directory and object store')
  const journal = await createFileJournal({ file: join(directory, 'revision-journal.json') })
  return {
    principal: DEV_PERSONAL_PRINCIPAL,
    journal,
    objects,
    revisions: createRevisionService({ journal, objects, now }),
    leases: createLeaseService({ journal, now, leaseTtlMs }),
    outbox: createOutboxService(journal),
  }
}
