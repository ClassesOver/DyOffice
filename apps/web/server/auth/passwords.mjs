import * as argon2 from 'argon2'
import { validateNewPassword, inspectArgon2idHash } from './credential-policy.mjs'

const ARGON2_OPTIONS = Object.freeze({
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
  hashLength: 32,
})

/**
 * Real Argon2id password hashing/verification. This provider intentionally
 * has no SHA/scrypt/PBKDF2 fallback, and bounds simultaneous memory-hard work.
 * Rate limiting and breached-password checks remain mandatory in T03b.
 */
export function createPasswordHasher({ maxConcurrent = 2 } = {}) {
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 8) {
    throw new TypeError('Invalid password-hash concurrency limit')
  }
  let running = 0
  async function limited(task) {
    if (running >= maxConcurrent) throw new Error('Password verification temporarily unavailable')
    running++
    try { return await task() }
    finally { running-- }
  }
  return Object.freeze({
    async hashPassword(password) {
      validateNewPassword(password)
      return limited(async () => {
        const hash = await argon2.hash(password, ARGON2_OPTIONS)
        if (!inspectArgon2idHash(hash)) throw new Error('Invalid Argon2id output')
        return hash
      })
    },
    async verifyPassword(hash, password) {
      if (typeof password !== 'string' || Buffer.byteLength(password, 'utf8') > 1024) return false
      if (!inspectArgon2idHash(hash)) return false
      return limited(async () => {
        try { return await argon2.verify(hash, password) }
        catch { return false } // Corrupt PHC data is an invalid credential, not a leaked native error.
      })
    },
  })
}
