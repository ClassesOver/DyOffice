import { assertPrincipal } from '../modules/revisions/errors.mjs'

/**
 * Read the revision outbox. Rows are inserted only by a committed revision
 * transaction. Delivery belongs to the later job dispatcher, so this service
 * does not mark events delivered or send them anywhere.
 */
export function createOutboxService(journal) {
  if (!journal || typeof journal.read !== 'function') throw new TypeError('outbox journal required')
  return {
    list(principal) {
      const owner = assertPrincipal(principal)
      return journal.read().outbox
        .filter((row) => row.ownerId === owner.ownerId && row.deploymentId === owner.deploymentId)
        .map((row) => ({ ...row }))
    },
  }
}
