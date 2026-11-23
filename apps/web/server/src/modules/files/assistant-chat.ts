import type { PrincipalTransactions } from '../../db/context.ts'
import { authError } from '../auth/sessions.ts'
import { uuidSchema } from './http-schema.ts'
import { loadFile, runFileTransaction, scope, uuid } from './queries.ts'

type Attachment = {name:string;ext:string;sizeBytes:number}
type Message = {turnId:string;role:'user'|'assistant';sender?:'dsh';text:string;state:'streaming'|'done'|'failed';seq:number;attachments?:Attachment[]}
type Request = {after?:number;updates?:Message[]}
const sequence={type:'integer',minimum:0,maximum:2147483647}
const maxAttachmentBytes=50*1024*1024
export const chatBodySchema={type:'object',additionalProperties:false,properties:{
  after:{type:'integer',minimum:0,maximum:Number.MAX_SAFE_INTEGER},
  updates:{type:'array',maxItems:8,items:{type:'object',additionalProperties:false,required:['turnId','role','text','state','seq'],properties:{
    turnId:uuidSchema,role:{enum:['user','assistant']},sender:{const:'dsh'},text:{type:'string',maxLength:24000},
    state:{enum:['streaming','done','failed']},seq:sequence,
    attachments:{type:'array',maxItems:20,items:{type:'object',additionalProperties:false,required:['name','ext','sizeBytes'],properties:{
      name:{type:'string',minLength:1,maxLength:255},ext:{type:'string',pattern:'^[a-z0-9]{1,12}$'},
      sizeBytes:{type:'integer',minimum:1,maximum:maxAttachmentBytes},
    }}},
  }}},
}}
const own='deployment_id=$1 AND owner_id=$2 AND file_id=$3'

// Keep one row per visible message rather than retaining every streaming token.
// The file-row lock orders acknowledgements, and also fences trash and permanent purge.
export function syncFileAssistantChat(tx:PrincipalTransactions,token:string,fileId:string,{after=0,updates=[]}:Request){
  const id=uuid(fileId)
  if(!Number.isSafeInteger(after)||after<0||!Array.isArray(updates)||updates.length>8)throw authError(400)
  for(const m of updates){
    uuid(m.turnId)
    if(!['assistant','user'].includes(m.role)||!['streaming','done','failed'].includes(m.state)||
      m.sender!==undefined&&(m.role!=='user'||m.sender!=='dsh')||
      !Number.isSafeInteger(m.seq)||m.seq<0||m.seq>2147483647||
      typeof m.text!=='string'||m.text.length>24000||m.text.includes('\0'))throw authError(400)
    if(m.attachments!==undefined&&(m.role!=='user'||m.state!=='done'||!Array.isArray(m.attachments)||m.attachments.length>20||
      m.attachments.some(a=>!a||Object.keys(a).some(key=>!['name','ext','sizeBytes'].includes(key))||
        typeof a.name!=='string'||!a.name.length||a.name.length>255||a.name.includes('\0')||
        typeof a.ext!=='string'||!/^[a-z0-9]{1,12}$/.test(a.ext)||
        !Number.isSafeInteger(a.sizeBytes)||a.sizeBytes<1||a.sizeBytes>maxAttachmentBytes)))throw authError(400)
  }
  return runFileTransaction(tx,token,updates.length?'files:write':'files:read',async(c,p)=>{
    await loadFile(c,p,id,false,updates.length?'UPDATE':'SHARE')
    const keys=[...scope(p),id]
    if(updates.length){
      const stats=(await c.query('SELECT max(changed) AS last,count(*) AS n FROM file_assistant_messages WHERE '+own,keys)).rows[0]
      let high=Number(stats.last??0),count=Number(stats.n)
      for(const m of updates){
        const args=[...keys,m.turnId,m.role]
        const previous=(await c.query('SELECT seq,state FROM file_assistant_messages WHERE '+own+' AND turn_id=$4 AND role=$5',args)).rows[0]
        if(previous && (previous.seq>=m.seq||previous.state!=='streaming'))continue
        if(previous){
          await c.query('UPDATE file_assistant_messages SET body=$6,state=$7,seq=$8,changed=$9 WHERE '+own+' AND turn_id=$4 AND role=$5',[...args,m.text,m.state,m.seq,++high])
        }else{
          if(++count>2048)throw authError(413)
          await c.query('INSERT INTO file_assistant_messages(deployment_id,owner_id,file_id,turn_id,role,body,state,seq,position,changed,sender,attachments) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10,$11)',[...args,m.text,m.state,m.seq,++high,m.sender??null,JSON.stringify(m.attachments??[])])
        }
      }
    }
    const {rows}=await c.query('SELECT turn_id,role,sender,body,state,seq,position,changed,attachments FROM file_assistant_messages WHERE '+own+' AND changed>$4 ORDER BY changed LIMIT 33',[...keys,after])
    const page=rows.slice(0,32)
    return {cursor:Number(page.at(-1)?.changed??after),hasMore:rows.length>32,messages:page.map(r=>({
      turnId:r.turn_id,role:r.role,...(r.sender?{sender:r.sender}:{}),...(r.attachments.length?{attachments:r.attachments}:{}),text:r.body,state:r.state,seq:r.seq,order:Number(r.position),
    }))}
  })
}
