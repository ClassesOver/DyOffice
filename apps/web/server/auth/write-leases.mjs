/**
 * Drop in-process write leases after a credential change.
 * The revision journal stays the T06 store. Clearing `sessionId` and advancing
 * the epoch matches an expired lease, so the previous holder cannot commit.
 * This is not PostgreSQL RLS and does not cancel a job already running.
 */
export async function dropWriteLeasesForOwner(journal, { ownerId, deploymentId } = {}) {
  if (!journal || typeof journal.read !== 'function' || typeof journal.transaction !== 'function') {
    throw new TypeError('revision journal required')
  }
  if (typeof ownerId !== 'string' || typeof deploymentId !== 'string') throw new TypeError('owner required')
  const ids = Object.entries(journal.read().leases || {})
    .filter(([, lease]) => lease && lease.ownerId === ownerId && lease.deploymentId === deploymentId && lease.sessionId != null)
    .map(([fileId]) => fileId)
  let dropped = 0
  for (const fileId of ids) {
    await journal.transaction(fileId, (snapshot) => {
      const lease = snapshot.leases[fileId]
      if (!lease || lease.ownerId !== ownerId || lease.deploymentId !== deploymentId || lease.sessionId == null) return
      snapshot.leases[fileId] = {
        epoch: lease.epoch + 1,
        sessionId: null,
        ownerId: null,
        deploymentId,
        expiresAt: 0,
      }
      dropped += 1
    })
  }
  return dropped
}
