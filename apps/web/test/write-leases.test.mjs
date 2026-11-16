import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createMemoryJournal } from '../server/src/modules/revisions/journal.mjs'
import { dropWriteLeasesForOwner } from '../server/auth/write-leases.mjs'

test('credential revocation clears only that owner write leases', async () => {
  const journal = createMemoryJournal()
  const ownerId = randomUUID()
  const otherId = randomUUID()
  const deploymentId = randomUUID()
  const owned = randomUUID()
  const foreign = randomUUID()
  await journal.transaction(owned, (snapshot) => {
    snapshot.leases[owned] = { epoch: 2, sessionId: 'session-a', ownerId, deploymentId, expiresAt: Date.now() + 1000 }
  })
  await journal.transaction(foreign, (snapshot) => {
    snapshot.leases[foreign] = { epoch: 4, sessionId: 'session-b', ownerId: otherId, deploymentId, expiresAt: Date.now() + 1000 }
  })
  assert.equal(await dropWriteLeasesForOwner(journal, { ownerId, deploymentId }), 1)
  const after = journal.read()
  assert.equal(after.leases[owned].sessionId, null)
  assert.equal(after.leases[owned].epoch, 3)
  assert.equal(after.leases[foreign].sessionId, 'session-b')
  assert.equal(after.leases[foreign].epoch, 4)
})
