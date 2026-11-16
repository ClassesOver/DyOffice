import { restrictedFixture } from './restricted.mjs'

/** Runtime services use auth credentials; owner pool is only for test setup/assertions. */
export async function restrictedIdentityFixture(t) {
  const f = await restrictedFixture(t, { seedAccounts: false })
  return { ...f, pool: f.ownerPool, observer: f.admin, user: f.initial }
}
