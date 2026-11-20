import type { PoolClient } from 'pg'
import type { BusinessPrincipal, PrincipalTransactions } from '../../db/context.ts'
import { authError } from '../auth/sessions.ts'
import { loadFile, runFileTransaction, scope, uuid } from '../files/queries.ts'

type Input = {revision:string;clientId:string;version?:number;steps?:Record<string,unknown>[]}
const range = 'deployment_id=$1 AND owner_id=$2 AND file_id=$3 AND epoch=$4'
const maxNumber = 2147483647
const versionOk = (v:unknown): v is number => Number.isInteger(v) && Number(v)>=0 && Number(v)<=maxNumber

// Only the built-in ProseMirror steps used by the Word editor are replayable.
function validStep(s:Record<string,unknown>) {
  if(!s || typeof s!=='object' || Array.isArray(s))return false
  const mark=s.mark as {type?:unknown}|undefined
  const span=versionOk(s.from)&&versionOk(s.to)&&s.from<=s.to
  switch(s.stepType) {
    case 'replace': return span
    case 'replaceAround': return span&&versionOk(s.gapFrom)&&versionOk(s.gapTo)&&s.gapFrom<=s.gapTo&&versionOk(s.insert)
    case 'addMark': case 'removeMark': return span&&typeof mark?.type==='string'
    case 'addNodeMark': case 'removeNodeMark': return versionOk(s.pos)&&typeof mark?.type==='string'
    case 'attr': return versionOk(s.pos)&&typeof s.attr==='string'
    case 'docAttr': return typeof s.attr==='string'
    default: return false
  }
}
async function baseline(c:PoolClient,p:BusinessPrincipal,file:string,revision:string) {
  const row=(await c.query<{epoch:string;version:number}>('SELECT coalesce(word_epoch,id) AS epoch,coalesce(word_version,0) AS version FROM file_revisions WHERE deployment_id=$1 AND owner_id=$2 AND file_id=$3 AND id=$4',[...scope(p),file,revision])).rows[0]
  if(!row)throw authError(409)
  return row
}
async function head(c:PoolClient,keys:string[],checkpoint:number){
  return Math.max(checkpoint,(await c.query('SELECT max(version) AS version FROM word_collab_steps WHERE '+range,keys)).rows[0].version??0)
}

// The file row serializes this short transaction with both other appends and DOCX saves.
export function syncWord(transactions:PrincipalTransactions,token:string,fileId:string,input:Input){
  const file=uuid(fileId),revision=uuid(input.revision),client=uuid(input.clientId),steps=input.steps??[]
  if((input.version!==undefined&&!versionOk(input.version)) || !Array.isArray(steps) || steps.length>64 ||
    !steps.every(validStep) ||
    (steps.length&&input.version===undefined))throw authError(400)
  return runFileTransaction(transactions,token,'files:write',async(c,p)=>{
    const current=await loadFile(c,p,file,false,steps.length?'UPDATE':'SHARE')
    if(current.format!=='docx')throw authError(415)
    const start=await baseline(c,p,file,revision)
    const latest=revision===current.current_revision?start:await baseline(c,p,file,current.current_revision)
    if(start.epoch!==latest.epoch)throw authError(409)
    const keys=[...scope(p),file,start.epoch]
    const end=await head(c,keys,latest.version),cursor=input.version??start.version
    if(cursor<start.version||cursor>end)throw authError(409)
    if(cursor===end && steps.length){
      // Bound outstanding recovery data when an editor never checkpoints.
      const bytes=Buffer.byteLength(JSON.stringify(steps))
      if(bytes>256*1024 || end-latest.version+steps.length>8192 || end+steps.length>maxNumber)throw authError(413)
      const outstanding=(await c.query('SELECT coalesce(sum(pg_column_size(step)),0)::bigint AS bytes FROM word_collab_steps WHERE '+range+' AND version>$5',[...keys,latest.version])).rows[0]
      if(Number(outstanding.bytes)+bytes>16*1024*1024)throw authError(413)
      await c.query('INSERT INTO word_collab_steps(deployment_id,owner_id,file_id,epoch,client_id,version,step) SELECT $1,$2,$3,$4,$5,$6::integer+i::integer,s FROM jsonb_array_elements($7) WITH ORDINALITY t(s,i)',[...keys,client,cursor,JSON.stringify(steps)])
    }
    const {rows}=await c.query('SELECT version,client_id,step FROM word_collab_steps WHERE '+range+' AND version>$5 ORDER BY version LIMIT 64',[...keys,cursor])
    // A very old client cannot jump over a compacted prefix. It must reopen.
    if(cursor<end && rows[0]?.version!==cursor+1)throw authError(409)
    return {savedRevision:current.current_revision,savedVersion:latest.version,baseVersion:start.version,version:rows.at(-1)?.version??cursor,steps:rows.map(r=>r.step),clientIDs:rows.map(r=>r.client_id)}
  })
}

// Caller holds the same file lock and commits the checkpoint with the artifact.
export async function wordCheckpoint(c:PoolClient,p:BusinessPrincipal,file:string,revision:string,version:number|undefined) {
  const base=await baseline(c,p,file,revision),keys=[...scope(p),file,base.epoch]
  const end=await head(c,keys,base.version)
  if(version===undefined){
    if(end>base.version)throw authError(409)
    await c.query('DELETE FROM word_collab_steps WHERE '+range,keys)
    return null
  }
  if(!versionOk(version)||version<base.version||version>end)throw authError(409)
  await c.query('DELETE FROM word_collab_steps WHERE '+range+' AND version<=$5',[...keys,version-256])
  return {epoch:base.epoch,version}
}
