import { assertFileId, assertLeaseEpoch, assertPrincipal, revisionError, LEASE_TTL_MS } from '../revisions/errors.mjs'

function requireOwned(snapshot, principal, fileId) {
  const file = snapshot.files[fileId]
  if (!file || file.ownerId !== principal.ownerId || file.deploymentId !== principal.deploymentId) {
    throw revisionError('NOT_FOUND', 404)
  }
  return file
}

function hold(principal, epoch, at, ttlMs) {
  return {
    epoch,
    sessionId: principal.sessionId,
    ownerId: principal.ownerId,
    deploymentId: principal.deploymentId,
    expiresAt: at + ttlMs,
  }
}

/**
 * One writable lease per file. acquire claims a free or expired lease.
 * renew extends the caller's current epoch. takeover always advances the
 * epoch so a previous holder cannot commit. Default lifetime is 45 seconds.
 */
export function createLeaseService({ journal, now = () => Date.now(), leaseTtlMs = LEASE_TTL_MS } = {}) {
  if (!journal || typeof journal.transaction !== 'function') throw new TypeError('lease journal required')
  function ttl(options) {
    const value = options?.ttlMs ?? leaseTtlMs
    if (!Number.isSafeInteger(value) || value < 1) throw revisionError('INVALID', 400)
    return value
  }

  return {
    async acquireLease(principal, fileId) {
      const owner = assertPrincipal(principal)
      const id = assertFileId(fileId)
      const at = now()
      const lifetime = ttl()
      return journal.transaction(id, (snapshot) => {
        requireOwned(snapshot, owner, id)
        const lease = snapshot.leases[id]
        if (!lease || lease.sessionId == null) {
          const next = hold(owner, lease?.epoch ?? 1, at, lifetime)
          snapshot.leases[id] = next
          return { leaseEpoch: next.epoch, expiresAt: next.expiresAt }
        }
        if (lease.expiresAt <= at) {
          const next = hold(owner, lease.epoch + 1, at, lifetime)
          snapshot.leases[id] = next
          return { leaseEpoch: next.epoch, expiresAt: next.expiresAt }
        }
        if (lease.sessionId === owner.sessionId && lease.ownerId === owner.ownerId && lease.deploymentId === owner.deploymentId) {
          return { leaseEpoch: lease.epoch, expiresAt: lease.expiresAt }
        }
        throw revisionError('LEASE_HELD', 409)
      })
    },

    async renewLease(principal, fileId, leaseEpoch) {
      const owner = assertPrincipal(principal)
      const id = assertFileId(fileId)
      const epoch = assertLeaseEpoch(leaseEpoch)
      const at = now()
      const lifetime = ttl()
      return journal.transaction(id, (snapshot) => {
        requireOwned(snapshot, owner, id)
        const lease = snapshot.leases[id]
        if (!lease || lease.sessionId !== owner.sessionId || lease.ownerId !== owner.ownerId || lease.deploymentId !== owner.deploymentId || lease.epoch !== epoch || lease.expiresAt <= at) {
          throw revisionError('LEASE_CONFLICT', 409)
        }
        lease.expiresAt = at + lifetime
        return { leaseEpoch: lease.epoch, expiresAt: lease.expiresAt }
      })
    },

    async takeoverLease(principal, fileId, options) {
      const owner = assertPrincipal(principal)
      const id = assertFileId(fileId)
      const at = now()
      const lifetime = ttl(options)
      return journal.transaction(id, (snapshot) => {
        requireOwned(snapshot, owner, id)
        const next = hold(owner, (snapshot.leases[id]?.epoch ?? 1) + 1, at, lifetime)
        snapshot.leases[id] = next
        return { leaseEpoch: next.epoch, expiresAt: next.expiresAt }
      })
    },

    currentLease(principal, fileId) {
      const owner = assertPrincipal(principal)
      const id = assertFileId(fileId)
      const snapshot = journal.read()
      requireOwned(snapshot, owner, id)
      const lease = snapshot.leases[id]
      if (!lease || lease.sessionId == null) return { leaseEpoch: lease?.epoch ?? 1, expiresAt: null, held: false }
      return { leaseEpoch: lease.epoch, expiresAt: lease.expiresAt, held: lease.expiresAt > now() }
    },
  }
}
