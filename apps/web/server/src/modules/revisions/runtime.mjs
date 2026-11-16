import { join } from 'node:path'
import { createOutboxService } from '../../outbox/service.mjs'
import { createLeaseService } from '../leases/service.mjs'
import { DEV_PERSONAL_PRINCIPAL } from '../policy/principal.mjs'
import { createFileJournal } from './journal.mjs'
import { createRevisionService } from './service.mjs'

export { DEV_PERSONAL_PRINCIPAL }

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
