import { hash, verify, parseOptions } from '@node-rs/argon2'
import { randomBytes } from 'node:crypto'

const policy = { algorithm: 2, version: 1, memoryCost: 19456, timeCost: 2, parallelism: 1, outputLen: 32 }
// Small offline starter denylist, not a comprehensive breached-password corpus.
// Deployments can append an approved local corpus; plaintext never leaves this process.
const commonPasswords = ['passwordpassword', 'password123456789', '123456789012345', '12345678901234567890', 'qwertyuiopasdfgh', 'correct horse battery staple', 'letmeinletmeinletmein']
const failure = (code: string) => Object.assign(new Error(code), { code })

export function normalizeUsername(value: unknown): string {
  if (typeof value !== 'string') throw failure('INVALID_USERNAME')
  const normalized = value.trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(normalized)) throw failure('INVALID_USERNAME')
  return normalized
}

export async function createPasswordService(options: { blockedPasswords?: string[]; maxConcurrent?: number; maxQueued?: number } = {}) {
  const blocked = new Set([...commonPasswords, ...(options.blockedPasswords ?? [])].map(value => value.toLowerCase()))
  const maxConcurrent = options.maxConcurrent ?? 2
  const maxQueued = options.maxQueued ?? 8
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 16 || !Number.isInteger(maxQueued) || maxQueued < 0 || maxQueued > 128) throw failure('INVALID_HASH_LIMIT')
  let active = 0
  const queue: Array<() => void> = []
  async function run<T>(operation: () => Promise<T>): Promise<T> {
    if (active < maxConcurrent) active++
    else {
      if (queue.length >= maxQueued) throw failure('AUTH_BUSY')
      await new Promise<void>(resolve => queue.push(resolve))
    }
    try { return await operation() }
    finally {
      const next = queue.shift()
      if (next) next()
      else active--
    }
  }
  const dummy = await run(() => hash(randomBytes(32), policy))
  function validInput(value: unknown): value is string {
    return typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= 1024
  }
  return {
    async hash(password: unknown): Promise<string> {
      if (!validInput(password) || [...password].length < 15 || !password.trim() || blocked.has(password.toLowerCase())) throw failure('INVALID_PASSWORD')
      return run(() => hash(password, policy))
    },
    async verifyCandidate(password: unknown, encoded?: string | null): Promise<boolean> {
      let accepted = validInput(password)
      let target = dummy
      if (encoded && encoded.length <= 512) {
        try {
          const parsed = parseOptions(encoded)
          if (parsed.algorithm === 2 && parsed.version === 1 && parsed.memoryCost >= 19456 && parsed.memoryCost <= 262144 && parsed.timeCost >= 2 && parsed.timeCost <= 10 && parsed.parallelism >= 1 && parsed.parallelism <= 4 && parsed.saltLen >= 16 && parsed.outputLen === 32) target = encoded
        } catch { /* Corrupt/unknown hashes perform the same bounded dummy verification. */ }
      }
      accepted = accepted && target !== dummy
      const matches = await run(() => verify(target, validInput(password) ? password : 'invalid credential'))
      return accepted && matches
    },
  }
}
export type PasswordService = Awaited<ReturnType<typeof createPasswordService>>
