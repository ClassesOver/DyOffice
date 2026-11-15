import { randomBytes } from 'node:crypto'
import type { Pool } from 'pg'
import { assertRuntimePool } from '../../db/roles.ts'
import { tokenHash } from '../auth/sessions.ts'
import { uuid } from '../files/queries.ts'

export type JobClaim = { jobId: string; artifactId: string; fileId: string; baseRevision: string; type: string; epoch: number; attempt: number; leaseUntil: string; deadlineAt: string; ownerId: string; sessionId: string; authVersion: number; objectKey: string; sha256: string; size: number; token: string }
export type JobDelivery = { jobId: string; deliveryEpoch: number; token: string }
export function createJobWorkerStore({ pool,deploymentId,leaseMs = 30_000,deliveryLeaseMs = 10_000,reconcileMs = 30_000 }: { pool: Pool; deploymentId: string; leaseMs?: number; deliveryLeaseMs?: number; reconcileMs?: number }) {
  const deployment = uuid(deploymentId)
  for (const value of [leaseMs,deliveryLeaseMs,reconcileMs]) if (!Number.isInteger(value) || value < 100 || value > 60_000) throw new Error('Invalid worker timing')
  let admitted: ReturnType<typeof assertRuntimePool> | undefined
  const secret = () => randomBytes(32).toString('base64url')
  async function call<T>(fn: string,values: unknown[]): Promise<T> {
    await (admitted ??= assertRuntimePool(pool,'worker'))
    const c = await pool.connect()
    let discard: Error | undefined
    try {
      await c.query('BEGIN')
      await c.query("SET LOCAL lock_timeout='5s'")
      await c.query("SET LOCAL statement_timeout='10s'")
      const result = (await c.query('SELECT ' + fn + '(' + values.map((_,i) => '$' + (i+1)).join(',') + ') AS value',values)).rows[0].value as T
      await c.query('COMMIT')
      return result
    } catch (error) {
      try { await c.query('ROLLBACK') } catch (failure) { discard = failure instanceof Error ? failure : new Error('Worker rollback failed') }
      throw error
    } finally { c.release(discard) }
  }
  return {
    get claimLeaseMs() { return leaseMs },
    async takeDelivery(): Promise<JobDelivery | null> { const token = secret(), value = await call<Omit<JobDelivery,'token'> | null>('take_job_delivery',[deployment,tokenHash(token),deliveryLeaseMs]); return value ? { ...value,token } : null },
    ackDelivery: (value: JobDelivery) => call<boolean>('ack_job_delivery',[deployment,uuid(value.jobId),value.deliveryEpoch,tokenHash(value.token),reconcileMs]),
    async claim(id: string): Promise<JobClaim | null> { const token = secret(), value = await call<Omit<JobClaim,'token'> | null>('claim_native_job',[deployment,uuid(id),tokenHash(token),leaseMs]); return value ? { ...value,token } : null },
    async renew(value: JobClaim): Promise<JobClaim | null> { const result = await call<{ epoch: number; leaseUntil: string } | null>('renew_native_job',[deployment,uuid(value.jobId),value.epoch,tokenHash(value.token),leaseMs]); return result ? { ...value,...result } : null },
    fail: (value: JobClaim,code: 'WORKER_FAILED' | 'NATIVE_FAILED' | 'RESOURCE_LIMIT' | 'TIMEOUT',retry: boolean) => call<boolean>('fail_native_job',[deployment,uuid(value.jobId),value.epoch,tokenHash(value.token),code,retry]),
  }
}
export type JobWorkerStore = ReturnType<typeof createJobWorkerStore>
