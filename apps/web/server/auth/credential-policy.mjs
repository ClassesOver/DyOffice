/** Account input validation; no account creation or password hashing is performed here. */
export const USERNAME_MIN_LENGTH = 3
export const USERNAME_MAX_LENGTH = 64
export const PASSWORD_MIN_CODEPOINTS = 15
export const PASSWORD_MAX_CODEPOINTS = 256
export const PASSWORD_MAX_UTF8_BYTES = 1024

/** Login identifiers are ASCII-only to avoid surprising Unicode case-fold collisions. */
export function normalizeUsername(value) {
  if (typeof value !== 'string') throw new TypeError('Invalid username')
  const normalized = value.trim().toLowerCase()
  if (normalized.length < USERNAME_MIN_LENGTH || normalized.length > USERNAME_MAX_LENGTH ||
      !/^[a-z][a-z0-9._-]*$/.test(normalized)) throw new TypeError('Invalid username')
  return normalized
}

// This small built-in blocklist is a fail-fast prefilter, not a replacement for
// the offline breached-password corpus required before production enrollment.
const COMMON_PASSWORDS = new Set([
  'passwordpassword', 'password123456789', '123456789012345', '1234567890123456',
  'qwertyuiopasdfgh', 'administrator123', 'letmeinletmein123',
])

export function validateNewPassword(value) {
  if (typeof value !== 'string') throw new TypeError('Invalid password')
  if (/[\u0000-\u001f\u007f]/u.test(value)) throw new TypeError('Invalid password')
  const codepoints = Array.from(value).length
  const bytes = Buffer.byteLength(value, 'utf8')
  if (codepoints < PASSWORD_MIN_CODEPOINTS || codepoints > PASSWORD_MAX_CODEPOINTS || bytes > PASSWORD_MAX_UTF8_BYTES) {
    throw new TypeError('Password outside allowed length')
  }
  if (COMMON_PASSWORDS.has(value.toLowerCase())) throw new TypeError('Password is commonly used')
  return true
}

/** Check a PHC Argon2id string without pretending to calculate or verify the hash. */
export function inspectArgon2idHash(value) {
  if (typeof value !== 'string') return null
  const match = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/.exec(value)
  if (!match) return null
  const [memoryKiB, passes, parallelism] = match.slice(1, 4).map(Number)
  if (!Number.isSafeInteger(memoryKiB) || !Number.isSafeInteger(passes) || !Number.isSafeInteger(parallelism) ||
      memoryKiB < 19456 || memoryKiB > 262144 || passes < 2 || passes > 10 || parallelism < 1 || parallelism > 8 ||
      match[4].length < 22 || match[5].length < 22) return null
  return { memoryKiB, passes, parallelism }
}
