import { createHmac } from 'node:crypto'
import type { IdentityStore } from '../../db/identity.ts'
import { normalizeUsername } from './passwords.ts'
import { authError } from './sessions.ts'
import { appendLoginAttempt, type AuthContext } from './audit.ts'

export interface LoginLimits { accountMax?: number; ipMax?: number; globalMax?: number; windowMs?: number }
export function createLoginThrottle(db: IdentityStore, deploymentId: string, key: string, config: LoginLimits = {}) {
  const limits = { account: config.accountMax ?? 10, ip: config.ipMax ?? 20, global: config.globalMax ?? 100 }
  const windowMs = config.windowMs ?? 60_000
  const retentionMs = Math.max(30 * 60_000, windowMs * 2)
  if (Object.values(limits).some(n => !Number.isSafeInteger(n) || n < 1 || n > 100_000) || !Number.isSafeInteger(windowMs) || windowMs < 1 || windowMs > 86400_000) throw new Error('Invalid login limits')
  return {
    async reserve(usernameInput: unknown, ip: string, context: AuthContext = {}) {
      let username = ''
      try { username = normalizeUsername(usernameInput) } catch { /* Invalid identities share one bounded bucket. */ }
      const bucket = (kind: keyof typeof limits, value: string) => ({ kind, hash: createHmac('sha256', key).update(`login-bucket:${kind}:${value}`).digest('hex') })
      const account = bucket('account', username), peer = bucket('ip', ip), global = bucket('global', 'global')
      const retryMs = await db.transaction(async connection => {
        // Global mutex first, then peer, then account. Reject admission before allocating
        // attacker-controlled account rows, and never charge password work to rejected peers.
        async function load(item: ReturnType<typeof bucket>) {
          await connection.query('INSERT INTO login_throttles(deployment_id,kind,key_hash) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [deploymentId, item.kind, item.hash])
          const { rows: [row] } = await connection.query('SELECT * FROM login_throttles WHERE deployment_id=$1 AND kind=$2 AND key_hash=$3 FOR UPDATE', [deploymentId, item.kind, item.hash])
          const now: Date = (await connection.query('SELECT clock_timestamp() AS now')).rows[0].now
          const alreadyBlocked = row.blocked_until && row.blocked_until > now
          const fresh = row.window_started_at.getTime() + windowMs <= now.getTime()
          const attempts = fresh ? 1 : row.attempts + 1
          const previousStrikes = row.window_started_at.getTime() + retentionMs < now.getTime() ? 0 : row.strikes
          const strikes = Math.min(previousStrikes + (attempts > limits[item.kind] ? 1 : 0), 16)
          const delay = attempts > limits[item.kind] ? Math.min(windowMs * 2 ** Math.min(strikes - 1, 10), 86400_000) : 0
          return { item, attempts, strikes, started: fresh ? now : row.window_started_at, blockedUntil: delay ? new Date(now.getTime() + delay) : null, retry: alreadyBlocked ? row.blocked_until.getTime() - now.getTime() : delay, alreadyBlocked }
        }
        async function store(state: Awaited<ReturnType<typeof load>>) {
          if (state.alreadyBlocked) return // Rejected traffic must not extend an active cooldown.
          await connection.query('UPDATE login_throttles SET attempts=$1,window_started_at=$2,blocked_until=$3,strikes=$4 WHERE deployment_id=$5 AND kind=$6 AND key_hash=$7', [state.attempts, state.started, state.blockedUntil, state.strikes, deploymentId, state.item.kind, state.item.hash])
        }
        async function reject(retry: number) {
          await appendLoginAttempt(connection, deploymentId, 'login_throttled', username, { ...context, accountKey: account.hash })
          return retry
        }
        const globalState = await load(global)
        await connection.query("DELETE FROM login_throttles WHERE deployment_id=$1 AND NOT(kind='global' AND key_hash=$2) AND window_started_at<clock_timestamp()-$3*interval '1 millisecond' AND (blocked_until IS NULL OR blocked_until<clock_timestamp())", [deploymentId, global.hash, retentionMs])
        if (globalState.retry) { await store(globalState); return reject(globalState.retry) }
        const peerState = await load(peer)
        await store(peerState)
        if (peerState.retry) return reject(peerState.retry)
        const accountState = await load(account)
        await store(accountState)
        if (accountState.retry) return reject(accountState.retry)
        await store(globalState)
        return 0
      })
      // Throw after COMMIT: denied attempts retain their narrow counters and audit intent.
      if (retryMs) throw Object.assign(authError(429), { retryAfter: Math.max(1, Math.ceil(retryMs / 1000)) })
      return { accountKey: account.hash }
    },
  }
}
