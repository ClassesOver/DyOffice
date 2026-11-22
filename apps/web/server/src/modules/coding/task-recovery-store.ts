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
/** Public task events: bounded, ordered, readable from any API instance. */
export type TaskEventKind='state'|'activity'|'progress'|'result'
export type TaskEvent={kind:TaskEventKind;payload:Record<string,unknown>}
export type StoredTaskEvent=TaskEvent&{sequence:number}
/** Activity/progress stop here; the remaining sequence numbers are kept for state events. */
const EVENT_SOFT_LIMIT=4000,EVENT_PAYLOAD_MAX=8192
const nextSequence=async(c:PoolClient,args:string[])=>(await c.query<{next:number}>(
  `SELECT COALESCE(max(sequence),0)+1 AS next FROM harness_task_events WHERE ${key}`,args.slice(0,4))).rows[0]!.next
async function insertEvents(c:PoolClient,args:string[],events:TaskEvent[]){
  let sequence=await nextSequence(c,args)
  for(const event of events){
    const payload=JSON.stringify(event.payload)
    if(Buffer.byteLength(payload)>EVENT_PAYLOAD_MAX)continue
    if(sequence>(event.kind==='state'||event.kind==='result'?4096:EVENT_SOFT_LIMIT))continue
    await c.query('INSERT INTO harness_task_events(deployment_id,owner_id,session_id,turn_id,sequence,kind,payload) VALUES($1,$2,$3,$4,$5,$6,$7)',[...args.slice(0,4),sequence++,event.kind,payload])
  }
}
export const interruptedFailure='Harness execution outcome could not be confirmed. Check for saved delivery before retrying.'

export function createCodingTaskRecoveryStore(transactions:PrincipalTransactions){
  const withFile=<T>(token:string,documentId:string,turnId:string,operation:(c:PoolClient,args:string[],revision:string)=>Promise<T>)=>
    runFileTransaction(transactions,token,'files:read',async(c,p)=>{
      const file=await loadFile(c,p,documentId)
      return operation(c,[...scope(p),p.sessionId,turnId,documentId],file.current_revision)
    })
  const where=key+' AND file_id=$5'
  async function recordExpired(c:PoolClient,args:string[]){
    const changed=await c.query(`UPDATE task_runtime_codex SET state='unknown_outcome',checkpoint=NULL,
      status_payload=(status_payload::jsonb || jsonb_build_object('failure',$6::text))::text
      WHERE ${where} AND ${active} AND lease_until<=clock_timestamp() AND expires_at>clock_timestamp()`,[...args,interruptedFailure])
    if(changed.rowCount)await insertEvents(c,args,[{kind:'state',payload:{state:'unknown_outcome',failure:interruptedFailure}}])
  }
  return {
    bindGrantLease(token:string,documentId:string,turnId:string){
      let runtimeId:string|undefined
      return ()=>withFile(token,documentId,turnId,async(c,args)=>{
        const {rows:[row]}=await c.query<{runtime_id:string;lease_until:Date}>(`SELECT runtime_id,lease_until FROM task_runtime_codex
          WHERE ${where} AND state='running' AND lease_until>clock_timestamp()`,args)
        if(!row||(runtimeId!==undefined&&row.runtime_id!==runtimeId))throw authError(403)
        runtimeId=row.runtime_id
        return row.lease_until.getTime()
      })
    },
    async listTaskIds(token:string,documentId:string){
      return runFileTransaction(transactions,token,'files:read',async(c,p)=>{
        await loadFile(c,p,documentId)
        const {rows}=await c.query<{turn_id:string}>(`SELECT task_id AS turn_id FROM task_runtime_status
          WHERE executor='codex' AND ${own} AND session_id=$3 AND file_id=$4 AND expires_at>clock_timestamp()
          ORDER BY (state IN ('running','cancel_requested')) DESC,expires_at DESC,task_id LIMIT 8`,[...scope(p),p.sessionId,documentId])
        return rows.map(row=>row.turn_id)
      })
    },
    async start(token:string,documentId:string,turnId:string,snapshot:Snapshot,continuation:Continuation|undefined,signal?:AbortSignal){
      await withFile(token,documentId,turnId,async(c,args,revision)=>{
        if(continuation&&continuation.revision!==revision)throw authError(409)
        // Serialize per-account cleanup and admission without locking other owners.
        await c.query("SELECT pg_advisory_xact_lock(hashtextextended('harness-recovery:'||$1||':'||$2,0))",args.slice(0,2))
        signal?.throwIfAborted()
        await c.query(`DELETE FROM task_runtime_codex WHERE ${own} AND expires_at<=clock_timestamp()`,args.slice(0,2))
        if((await c.query(`SELECT 1 FROM task_runtime_codex WHERE ${key}`,args.slice(0,4))).rowCount)throw authError(409)
        const {rows:[{count}]}=await c.query<{count:number}>(`SELECT count(*)::int AS count FROM task_runtime_codex WHERE ${own} AND ${validLease}`,args.slice(0,2))
        if(count>=32)throw authError(429)
        await c.query(`INSERT INTO task_runtime_codex(deployment_id,owner_id,session_id,turn_id,file_id,state,status_payload,checkpoint,renewed_at,lease_until,expires_at)
          VALUES($1,$2,$3,$4,$5,'running',$6,$7,clock_timestamp(),clock_timestamp()+${lease},clock_timestamp()+${lease}+${retention})`,
        [...args,JSON.stringify(snapshot),continuation?JSON.stringify(continuation):null])
        await insertEvents(c,args,[{kind:'state',payload:{state:'running'}}])
      })
    },
    /** Append live events while this executor still holds the lease; false once it does not. */
    async append(token:string,documentId:string,turnId:string,events:TaskEvent[]){
      if(!events.length)return true
      return withFile(token,documentId,turnId,async(c,args)=>{
        const {rowCount}=await c.query(`SELECT 1 FROM task_runtime_codex WHERE ${where} AND ${validLease} FOR UPDATE`,args)
        if(!rowCount)return false
        await insertEvents(c,args,events)
        return true
      })
    },
    /** Events after a sequence number plus the task's effective state. */
    async events(token:string,documentId:string,turnId:string,after:number){
      return withFile(token,documentId,turnId,async(c,args)=>{
        await recordExpired(c,args)
        const {rows:[row]}=await c.query<{state:TaskState}>(`SELECT state FROM task_runtime_status
          WHERE executor='codex' AND ${own} AND session_id=$3 AND task_id=$4 AND file_id=$5 AND expires_at>clock_timestamp()`,args)
        if(!row)throw authError(404)
        const {rows}=await c.query<{sequence:number;kind:TaskEventKind;payload:string}>(`SELECT sequence,kind,payload FROM harness_task_events
          WHERE ${key} AND sequence>$5 ORDER BY sequence LIMIT 256`,[...args.slice(0,4),after])
        return {state:row.state,
          events:rows.map(event=>({sequence:event.sequence,kind:event.kind,payload:JSON.parse(event.payload) as Record<string,unknown>}))}
      })
    },
    async renew(token:string,documentId:string,turnId:string,snapshot:Snapshot){
      return withFile(token,documentId,turnId,async(c,args)=>{
        await c.query("SELECT pg_advisory_xact_lock(hashtextextended('harness-recovery:'||$1||':'||$2,0))",args.slice(0,2))
        return !!(await c.query(`UPDATE task_runtime_codex
          SET status_payload=$6,renewed_at=clock_timestamp(),lease_until=clock_timestamp()+${lease},expires_at=clock_timestamp()+${lease}+${retention}
          WHERE ${where} AND state='running' AND lease_until>clock_timestamp()`,[...args,JSON.stringify(snapshot)])).rowCount
      })
    },
    async finish(token:string,documentId:string,turnId:string,task:Task){
      return withFile(token,documentId,turnId,async(c,args)=>{
        const {rows:[row]}=await c.query<{state:TaskState}>(`SELECT state FROM task_runtime_codex WHERE ${where} AND ${validLease} FOR UPDATE`,args)
        if(!row)throw authError(409)
        const {state,continuation,...snapshot}=task
        const interrupted=row.state==='cancel_requested'&&state==='succeeded'
        if(interrupted){delete snapshot.result;snapshot.failure=interruptedFailure}
        const savedState=interrupted?'unknown_outcome':state
        const settled=await c.query(`UPDATE task_runtime_codex SET state=$6,status_payload=$7,checkpoint=CASE WHEN $6='succeeded' THEN checkpoint ELSE NULL END,
          expires_at=clock_timestamp()+${retention} WHERE ${where} AND state=$8 AND lease_until>clock_timestamp()`,[...args,savedState,JSON.stringify(snapshot),row.state])
        if(!settled.rowCount)throw authError(409)
        if(savedState==='succeeded'&&snapshot.result)await insertEvents(c,args,[{kind:'result',payload:{turnId}}])
        await insertEvents(c,args,[{kind:'state',payload:{state:savedState,...(snapshot.failure?{failure:snapshot.failure.slice(0,2000)}:{})}}])
        return {state:savedState,...snapshot}
      })
    },
    async access<T>(token:string,documentId:string,turnId:string,mutating:boolean,operation:(task:Task,revision:string)=>{value:T;consume?:boolean}){
      return withFile(token,documentId,turnId,async(c,args,revision)=>{
        await recordExpired(c,args)
        const {rows:[row]}=await c.query<Row>(`SELECT state,status_payload,checkpoint,lease_until>clock_timestamp() AS live
          FROM task_runtime_codex WHERE ${where} AND expires_at>clock_timestamp() ${mutating?'FOR UPDATE':''}`,args)
        if(!row)throw authError(404)
        const snapshot=JSON.parse(row.status_payload) as Snapshot
        const interrupted=!row.live&&(row.state==='running'||row.state==='cancel_requested')
        const continuation=row.state==='succeeded'&&row.checkpoint?JSON.parse(row.checkpoint) as Continuation:undefined
        const {value,consume}=operation({...snapshot,state:interrupted?'unknown_outcome':row.state,
          ...(interrupted?{failure:interruptedFailure}:{}),...(continuation?.revision===revision?{continuation}:{})},revision)
        if(consume)await c.query(`UPDATE task_runtime_codex SET checkpoint=NULL WHERE ${where}`,args)
        return value
      })
    },
    async cancel(token:string,turnId:string){
      return runFileTransaction(transactions,token,'files:read',async(c,p)=>{
        const args=[...scope(p),p.sessionId,turnId]
        const {rows:[row]}=await c.query<{file_id:string}>(`SELECT file_id FROM task_runtime_codex WHERE ${key} AND ${validLease}`,args)
        if(!row)return false
        await loadFile(c,p,row.file_id)
        const cancelled=!!(await c.query(`UPDATE task_runtime_codex SET state='cancel_requested',cancel_requested=true WHERE ${where} AND state='running' AND lease_until>clock_timestamp()`,[...args,row.file_id])).rowCount
        if(cancelled)await insertEvents(c,args,[{kind:'state',payload:{state:'cancel_requested'}}])
        return cancelled
      })
    },
  }
}
export type CodingTaskRecoveryStore=ReturnType<typeof createCodingTaskRecoveryStore>
