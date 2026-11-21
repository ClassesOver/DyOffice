import type { PrincipalTransactions } from '../../db/context.ts'
import type { PoolClient } from 'pg'
import type { HarnessCheckpoint } from '../../../../../../packages/agent-core/src/loop.ts'
import { authError } from '../auth/sessions.ts'
import { loadFile, runFileTransaction, scope } from '../files/queries.ts'

export type Continuation={revision:string;modelId:string;checkpoint:HarnessCheckpoint;callId:string}
export type TaskState='running'|'cancel_requested'|'succeeded'|'failed'|'unknown_outcome'
type Snapshot={modelId:string;instruction?:string;activity?:string;progress?:string;result?:unknown;failure?:string}
type Task={state:TaskState;continuation?:Continuation}&Snapshot
type Row={state:TaskState;status_payload:string;checkpoint:string|null;live:boolean}
const own='deployment_id=$1 AND owner_id=$2'
const key=own+' AND session_id=$3 AND turn_id=$4'
const retention="interval '10 minutes'",lease="interval '30 seconds'"
const active="state IN ('running','cancel_requested')"
const validLease=`${active} AND lease_until>clock_timestamp()`
export const interruptedFailure='Harness execution outcome could not be confirmed. Check for saved delivery before retrying.'

export function createCodingTaskRecoveryStore(transactions:PrincipalTransactions){
  const withFile=<T>(token:string,documentId:string,turnId:string,operation:(c:PoolClient,args:string[],revision:string)=>Promise<T>)=>
    runFileTransaction(transactions,token,'files:read',async(c,p)=>{
      const file=await loadFile(c,p,documentId)
      return operation(c,[...scope(p),p.sessionId,turnId,documentId],file.current_revision)
    })
  const where=key+' AND file_id=$5'
  return {
    async start(token:string,documentId:string,turnId:string,snapshot:Snapshot,continuation:Continuation|undefined,signal?:AbortSignal){
      await withFile(token,documentId,turnId,async(c,args,revision)=>{
        if(continuation&&continuation.revision!==revision)throw authError(409)
        // Serialize per-account eviction and admission without locking other owners.
        await c.query("SELECT pg_advisory_xact_lock(hashtextextended('harness-recovery:'||$1||':'||$2,0))",args.slice(0,2))
        signal?.throwIfAborted()
        await c.query(`DELETE FROM harness_task_recovery WHERE ${own} AND expires_at<=clock_timestamp()`,args.slice(0,2))
        if((await c.query(`SELECT 1 FROM harness_task_recovery WHERE ${key}`,args.slice(0,4))).rowCount)throw authError(409)
        const {rows:[{count}]}=await c.query<{count:number}>(`SELECT count(*)::int AS count FROM harness_task_recovery WHERE ${own}`,args.slice(0,2))
        if(count>=32)throw authError(429)
        await c.query(`INSERT INTO harness_task_recovery(deployment_id,owner_id,session_id,turn_id,file_id,state,status_payload,checkpoint,lease_until,expires_at)
          VALUES($1,$2,$3,$4,$5,'running',$6,$7,clock_timestamp()+${lease},clock_timestamp()+${lease}+${retention})`,
        [...args,JSON.stringify(snapshot),continuation?JSON.stringify(continuation):null])
      })
    },
    async renew(token:string,documentId:string,turnId:string,snapshot:Snapshot){
      return withFile(token,documentId,turnId,async(c,args)=>!!(await c.query(`UPDATE harness_task_recovery
        SET status_payload=$6,lease_until=clock_timestamp()+${lease},expires_at=clock_timestamp()+${lease}+${retention}
        WHERE ${where} AND state='running' AND lease_until>clock_timestamp()`,[...args,JSON.stringify(snapshot)])).rowCount)
    },
    async finish(token:string,documentId:string,turnId:string,task:Task){
      return withFile(token,documentId,turnId,async(c,args)=>{
        const {rows:[row]}=await c.query<{state:TaskState}>(`SELECT state FROM harness_task_recovery WHERE ${where} AND ${validLease} FOR UPDATE`,args)
        if(!row)throw authError(409)
        const {state,continuation,...snapshot}=task
        const interrupted=row.state==='cancel_requested'&&state==='succeeded'
        if(interrupted){delete snapshot.result;snapshot.failure=interruptedFailure}
        const savedState=interrupted?'unknown_outcome':state
        await c.query(`UPDATE harness_task_recovery SET state=$6,status_payload=$7,checkpoint=CASE WHEN $6='succeeded' THEN checkpoint ELSE NULL END,
          expires_at=clock_timestamp()+${retention} WHERE ${where}`,[...args,savedState,JSON.stringify(snapshot)])
        return {state:savedState,...snapshot}
      })
    },
    async access<T>(token:string,documentId:string,turnId:string,mutating:boolean,operation:(task:Task,revision:string)=>{value:T;consume?:boolean}){
      return withFile(token,documentId,turnId,async(c,args,revision)=>{
        const {rows:[row]}=await c.query<Row>(`SELECT state,status_payload,checkpoint,lease_until>clock_timestamp() AS live
          FROM harness_task_recovery WHERE ${where} AND expires_at>clock_timestamp() ${mutating?'FOR UPDATE':''}`,args)
        if(!row)throw authError(404)
        const snapshot=JSON.parse(row.status_payload) as Snapshot
        const interrupted=!row.live&&(row.state==='running'||row.state==='cancel_requested')
        const continuation=row.state==='succeeded'&&row.checkpoint?JSON.parse(row.checkpoint) as Continuation:undefined
        const {value,consume}=operation({...snapshot,state:interrupted?'unknown_outcome':row.state,
          ...(interrupted?{failure:interruptedFailure}:{}),...(continuation?.revision===revision?{continuation}:{})},revision)
        if(consume)await c.query(`UPDATE harness_task_recovery SET checkpoint=NULL WHERE ${where}`,args)
        return value
      })
    },
    async cancel(token:string,turnId:string){
      return runFileTransaction(transactions,token,'files:read',async(c,p)=>{
        const args=[...scope(p),p.sessionId,turnId]
        const {rows:[row]}=await c.query<{file_id:string}>(`SELECT file_id FROM harness_task_recovery WHERE ${key} AND ${validLease}`,args)
        if(!row)return false
        await loadFile(c,p,row.file_id)
        return !!(await c.query(`UPDATE harness_task_recovery SET state='cancel_requested' WHERE ${where} AND state='running' AND lease_until>clock_timestamp()`,[...args,row.file_id])).rowCount
      })
    },
  }
}
export type CodingTaskRecoveryStore=ReturnType<typeof createCodingTaskRecoveryStore>
