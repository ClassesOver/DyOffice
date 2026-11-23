import type { PoolClient } from 'pg'
import type { BusinessPrincipal, PrincipalTransactions } from '../../db/context.ts'
import { authorize } from '../policy/authorize.ts'
import { authError, tokenHash } from '../auth/sessions.ts'

const MAX_LAYOUT_BYTES=64*1024
type TemplateData={topic:string;styleSkill:string;createdAt:string;layout?:unknown}

export function createStyleTemplateService(transactions:PrincipalTransactions){
 const nameOf=(value:string)=>{
  if(typeof value!=='string')throw authError(400)
  const name=value.trim().replace(/[/\\:*?"<>|]/g,'_').slice(0,64)
  if(!name||name.includes('\0'))throw authError(400)
  return name
 }
 const plainObject=(value:unknown):value is Record<string,unknown>=>typeof value==='object'&&value!==null&&!Array.isArray(value)
 const validColor=(value:unknown)=>typeof value==='string'&&/^#[0-9a-fA-F]{6}$/.test(value)
 const validBox=(value:unknown)=>plainObject(value)&&['x','y','w','h'].every(key=>typeof value[key]==='number'&&Number.isFinite(value[key])&&Math.abs(value[key] as number)<=100_000)&&Number(value.w)>0&&Number(value.h)>0
 function validLayout(value:unknown){
  if(!plainObject(value))return false
  const canvas=value.canvas
  if(!plainObject(canvas)||!['w','h'].every(key=>typeof canvas[key]==='number'&&Number.isFinite(canvas[key])&&Number(canvas[key])>0&&Number(canvas[key])<=100_000))return false
  for(const role of ['cover','content','closing']){
   const item=value[role]
   if(item===undefined)continue
   if(!plainObject(item)||item.background!==undefined&&!validColor(item.background))return false
   const title=item.title,brandImage=item.brandImage
   if(title!==undefined&&(!plainObject(title)||!validBox(title)||typeof title.sizePt!=='number'||!Number.isFinite(title.sizePt)||title.sizePt<=0||title.sizePt>1000||title.color!==undefined&&!validColor(title.color)))return false
   if(brandImage!==undefined&&(!plainObject(brandImage)||!validBox(brandImage)||!Number.isSafeInteger(brandImage.pages)||Number(brandImage.pages)<1||Number(brandImage.pages)>1000))return false
   if(item.accents!==undefined&&(!Array.isArray(item.accents)||item.accents.length>2||!item.accents.every(accent=>validBox(accent)&&plainObject(accent)&&(accent.fill===undefined||validColor(accent.fill)))))return false
  }
  return true
 }
 const access=<T>(token:string,write:boolean,run:(c:PoolClient,p:BusinessPrincipal)=>Promise<T>)=>transactions.withPrincipalTransaction({kind:'session',token},async(c,p)=>{
  authorize(p,write?'preferences:write':'preferences:read',{deploymentId:p.deploymentId,ownerId:p.userId})
  await c.query("SELECT set_config('dyoffice.global_session_hash',$1,true),set_config('dyoffice.global_idle_ms',$2,true)",[tokenHash(token),String(transactions.sessionIdleMs)])
  return run(c,p)
 })
 function dataOf(value:unknown):{topic:string;styleSkill:string;createdAt:Date;layoutJson:string|null}{
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['topic','styleSkill','createdAt','layout'].includes(key)))throw authError(400)
  const data=value as TemplateData
  if(typeof data.topic!=='string'||Buffer.byteLength(data.topic)>4096||data.topic.includes('\0')||typeof data.styleSkill!=='string'||!data.styleSkill.trim()||Buffer.byteLength(data.styleSkill)>262144||data.styleSkill.includes('\0')||typeof data.createdAt!=='string'||data.createdAt.length>64||!Number.isFinite(Date.parse(data.createdAt)))throw authError(400)
  let layoutJson:string|null=null
  if(data.layout!==undefined){
   if(!validLayout(data.layout))throw authError(400)
   try{layoutJson=JSON.stringify(data.layout)}catch{throw authError(400)}
   if(layoutJson.includes('\\u0000')||Buffer.byteLength(layoutJson)>MAX_LAYOUT_BYTES)throw authError(400)
  }
  return {topic:data.topic,styleSkill:data.styleSkill,createdAt:new Date(data.createdAt),layoutJson}
 }
 return {
  list:(token:string)=>access<Array<{name:string;topic:string;createdAt:string}>>(token,false,async(c,p)=>{
   const rows=(await c.query('SELECT name,topic,created_at FROM user_style_templates WHERE deployment_id=$1 AND owner_id=$2 ORDER BY name',[p.deploymentId,p.userId])).rows
   return rows.map(row=>({name:row.name,topic:row.topic,createdAt:new Date(row.created_at).toISOString()}))
  }),
  load:(token:string,value:string)=>access(token,false,async(c,p)=>{
   const name=nameOf(value)
   const row=(await c.query('SELECT name,topic,style_skill,layout FROM user_style_templates WHERE deployment_id=$1 AND owner_id=$2 AND name=$3',[p.deploymentId,p.userId,name])).rows[0]
   if(!row)return {ok:false,error:'Style template not found.'}
   return {ok:true,topic:row.topic,styleSkill:row.style_skill,...(row.layout?{layout:row.layout}:{})}
  }),
  save:async(token:string,value:string,raw:unknown)=>{
   const name=nameOf(value),data=dataOf(raw)
   return access(token,true,async(c,p)=>{
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['style-templates:'+p.deploymentId+':'+p.userId])
    const count=await c.query('SELECT count(*)::integer AS count FROM user_style_templates WHERE deployment_id=$1 AND owner_id=$2 AND name<>$3',[p.deploymentId,p.userId,name])
    if(count.rows[0].count>=100)throw authError(409)
    const result=await c.query('INSERT INTO user_style_templates(deployment_id,owner_id,workspace_id,name,topic,style_skill,created_at,layout) SELECT $1,$2,id,$3,$4,$5,$6,$7::jsonb FROM workspaces WHERE deployment_id=$1 AND owner_id=$2 ON CONFLICT(deployment_id,owner_id,name) DO UPDATE SET topic=EXCLUDED.topic,style_skill=EXCLUDED.style_skill,created_at=EXCLUDED.created_at,layout=EXCLUDED.layout RETURNING name',[p.deploymentId,p.userId,name,data.topic,data.styleSkill,data.createdAt,data.layoutJson])
    if(!result.rowCount)throw authError(404)
    return {ok:true}
   })
  },
 }
}
