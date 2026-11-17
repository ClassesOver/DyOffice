import { createHash,randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import type { BusinessPrincipal,PrincipalTransactions } from '../../db/context.ts'
import { authError } from '../auth/sessions.ts'
import { uuid,scope,runFileTransaction } from '../files/queries.ts'

type Row = { id: string; type: string; artifact_id: string; file_id: string; state: string; attempts: number; error_code: string | null; result_revision: string | null; created_at: Date; deadline_at: Date; finished_at: Date | null; request_hash: string }
const dto = (j: Row) => ({ id: j.id,type: j.type,artifactId: j.artifact_id,fileId: j.file_id,state: j.state,attempts: j.attempts,errorCode: j.error_code,resultRevision: j.result_revision,createdAt: j.created_at.toISOString(),deadlineAt: j.deadline_at.toISOString(),finishedAt: j.finished_at?.toISOString() ?? null })
/** Internal trusted transaction primitive. Caller must establish authenticated
 * files:write authority and validate/snapshot inputs before invoking; never HTTP.
 * Shared by generic enqueue and the test-only PDF command binding transaction. */
async function enqueueNativeJobInTransaction(c:PoolClient,p:BusinessPrincipal,{type,artifactId,idempotencyKey,hash,idleMs,maxActiveJobs,maxAttempts,deadlineMs}:{type:string;artifactId:string;idempotencyKey:string;hash:string;idleMs:number;maxActiveJobs:number;maxAttempts:number;deadlineMs:number},binding?: (c:PoolClient,p:BusinessPrincipal,job:ReturnType<typeof dto>,created:boolean)=>Promise<void>){
        if(p.job)throw authError(404)
        // Serialize enqueue/idempotency/quota before taking a file or job lock.
        await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[p.deploymentId + '/' + p.userId + '/native-jobs'])
        const prior = (await c.query<Row>('SELECT * FROM native_jobs WHERE deployment_id=$1 AND owner_id=$2 AND idempotency_key=$3 FOR SHARE',[...scope(p),idempotencyKey])).rows[0]
        if (prior) {
          if (prior.request_hash !== hash) throw authError(409)
          const retired = await c.query('SELECT 1 FROM files WHERE deployment_id=$1 AND owner_id=$2 AND id=$3 AND purge_started_at IS NOT NULL',[...scope(p),prior.file_id])
          if (retired.rowCount) throw authError(410)
          if(binding)await binding(c,p,dto(prior),false)
          return dto(prior)
        }
        const artifact = (await c.query('SELECT r.file_id,f.current_revision,f.format FROM file_revisions r JOIN files f ON f.deployment_id=r.deployment_id AND f.owner_id=r.owner_id AND f.id=r.file_id WHERE r.deployment_id=$1 AND r.owner_id=$2 AND r.id=$3 AND f.deleted_at IS NULL FOR SHARE OF f',[...scope(p),artifactId])).rows[0]
        if (!artifact) throw authError(404)
        if (artifact.current_revision !== artifactId) throw authError(409)
        if (!type.startsWith(artifact.format + '.')) throw authError(400)
        const pending = await c.query("SELECT 1 FROM native_jobs WHERE deployment_id=$1 AND owner_id=$2 AND state IN ('queued','running')",scope(p))
        if ((pending.rowCount ?? 0) >= maxActiveJobs) throw authError(429)
        const id = randomUUID()
        const { rows: [job] } = await c.query<Row>("INSERT INTO native_jobs(id,deployment_id,owner_id,session_id,auth_version,idle_ms,file_id,artifact_id,type,idempotency_key,request_hash,max_attempts,deadline_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,clock_timestamp()+$13*interval '1 millisecond') RETURNING *",[id,...scope(p),p.sessionId,p.authVersion,idleMs,artifact.file_id,artifactId,type,idempotencyKey,hash,maxAttempts,deadlineMs])
        await c.query('INSERT INTO job_outbox(job_id,deployment_id,owner_id) VALUES($1,$2,$3)',[id,...scope(p)])
        if(binding)await binding(c,p,dto(job),true)
        return dto(job)
}
const defaultPolicy=Object.freeze({maxActiveJobs:16,maxAttempts:3,deadlineMs:15*60_000})
function jobPolicy(transactions:PrincipalTransactions,{maxActiveJobs=defaultPolicy.maxActiveJobs,maxAttempts=defaultPolicy.maxAttempts,deadlineMs=defaultPolicy.deadlineMs}:{maxActiveJobs?:number;maxAttempts?:number;deadlineMs?:number}={}){
 const idleMs=transactions.sessionIdleMs
 if (!Number.isSafeInteger(maxActiveJobs) || maxActiveJobs < 1 || maxActiveJobs > 1000 || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10 || !Number.isSafeInteger(deadlineMs) || deadlineMs < 100 || deadlineMs > 3600_000 || !Number.isSafeInteger(idleMs) || idleMs < 1 || idleMs > 2592000000) throw new Error('Invalid job policy')
 return {idleMs,maxActiveJobs,maxAttempts,deadlineMs}
}
export function createJobService({ transactions,enabledTypes = [],maxActiveJobs = defaultPolicy.maxActiveJobs,maxAttempts = defaultPolicy.maxAttempts,deadlineMs = defaultPolicy.deadlineMs }: { transactions: PrincipalTransactions; enabledTypes?: readonly string[]; maxActiveJobs?: number; maxAttempts?: number; deadlineMs?: number }) {
  const {idleMs}=jobPolicy(transactions,{maxActiveJobs,maxAttempts,deadlineMs})
  const enabled = new Set(enabledTypes)
  for (const type of enabled) if (!/^(docx|xlsx|pptx|pdf)\.[a-z][a-z0-9_]{0,31}$/.test(type)) throw new Error('Invalid job type')
  const run = <T>(token: string,write: boolean,fn: (c: PoolClient,p: BusinessPrincipal) => Promise<T>) => runFileTransaction(transactions,token,write ? 'files:write' : 'files:read',(c,p) => { if (p.job) throw authError(404); return fn(c,p) })
  return {
    async enqueueJob(token: string,type: string,input: { artifactId: string },idempotencyKey: string) {
      if (!enabled.has(type) || !input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'artifactId') || typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(idempotencyKey)) throw authError(400)
      const artifactId = uuid(input.artifactId), hash = createHash('sha256').update(JSON.stringify({ type,artifactId })).digest('hex')
      return run<ReturnType<typeof dto>>(token,true,async (c,p) => {
        return enqueueNativeJobInTransaction(c,p,{type,artifactId,idempotencyKey,hash,idleMs,maxActiveJobs,maxAttempts,deadlineMs})
      })
    },
    getJob: (token: string,id: string) => run<ReturnType<typeof dto>>(token,false,async (c,p) => {
      const row = (await c.query<Row>('SELECT * FROM native_jobs WHERE deployment_id=$1 AND owner_id=$2 AND id=$3',[...scope(p),uuid(id)])).rows[0]
      if (!row) throw authError(404)
      return dto(row)
    }),
    listJobs: (token: string) => run<{ jobs: ReturnType<typeof dto>[] }>(token,false,async (c,p) => ({ jobs: (await c.query<Row>('SELECT * FROM native_jobs WHERE deployment_id=$1 AND owner_id=$2 ORDER BY created_at DESC,id DESC LIMIT 100',scope(p))).rows.map(dto) })),
    cancelJob: (token: string,id: string) => run<ReturnType<typeof dto>>(token,true,async (c,p) => {
      const row = (await c.query<Row>('SELECT * FROM native_jobs WHERE deployment_id=$1 AND owner_id=$2 AND id=$3 FOR UPDATE',[...scope(p),uuid(id)])).rows[0]
      if (!row) throw authError(404)
      if (['queued','running'].includes(row.state)) {
        const cancelled = (await c.query<Row>("UPDATE native_jobs SET state='cancelled',error_code='CANCELLED',finished_at=clock_timestamp(),claim_epoch=LEAST(claim_epoch+1,9007199254740991),claim_hash=NULL,lease_until=NULL WHERE id=$1 RETURNING *",[row.id])).rows[0]
        await c.query('UPDATE edit_leases SET expires_at=clock_timestamp() WHERE deployment_id=$1 AND owner_id=$2 AND job_id=$3',[...scope(p),row.id])
        return dto(cancelled)
      }
      return dto(row)
    }),
  }
}

/** Test-only binding extension: derives the principal itself, never accepts owner
 * or session facts from a caller. The binding runs inside the SAME enqueue tx.
 * No production registration or alternate quota/outbox implementation. */
export async function enqueueTestBoundNativeJob({transactions,token,type,artifactId,idempotencyKey,hash,binding}:{transactions:PrincipalTransactions;token:string;type:string;artifactId:string;idempotencyKey:string;hash:string;binding:(c:PoolClient,p:BusinessPrincipal,job:ReturnType<typeof dto>,created:boolean)=>Promise<void>}){
 if(process.env.NODE_ENV!=='test')throw authError(403)
 const policy=jobPolicy(transactions)
 if(type!=='pdf.rotate'||!/^[A-Za-z0-9_-]{8,128}$/.test(idempotencyKey)||!/^[a-f0-9]{64}$/.test(hash))throw authError(400)
 const artifact=uuid(artifactId)
 return runFileTransaction(transactions,token,'files:write',async(c,p)=>{
  if(process.env.NODE_ENV!=='test'||p.job)throw authError(403)
  return enqueueNativeJobInTransaction(c,p,{type,artifactId:artifact,idempotencyKey,hash,...policy},binding)
 })
}
