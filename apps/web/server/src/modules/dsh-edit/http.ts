import {randomBytes,timingSafeEqual} from 'node:crypto'
import type {FastifyInstance,FastifyRequest} from 'fastify'
import type {McpPrincipalTransactions} from '../../db/context.ts'
import {cookies,uniqueHeader,type createCsrfService} from '../auth/csrf.ts'
import {authError,type SessionService} from '../auth/sessions.ts'
import {preferenceDefaults} from '../preferences/service.ts'

const idPattern=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
const tokenPattern=/^[A-Za-z0-9_-]{43}$/
const nativePath=/^\/native-(docx|xlsx|pptx|pdf)\/(?:index\.html)?$/
// Only the scoped editor routes read this request credential. The account cookie parser stays unchanged.
const requestTokens=new WeakMap<FastifyRequest,string>()
export const isDshEditorRequest=(request:FastifyRequest)=>requestTokens.has(request)
export const editorFileToken=(request:FastifyRequest)=>requestTokens.get(request)??cookies(request).session??''

export async function authenticateEditorFile(
 request:FastifyRequest,
 sessions:SessionService,
 csrf:ReturnType<typeof createCsrfService>,
 mutation:boolean,
 missingStatus:401|403=401,
) {
 const guestToken=requestTokens.get(request)
 if(guestToken!==undefined)return guestToken
 const token=cookies(request).session
 if(!token)throw authError(missingStatus)
 csrf.originCheck(request,mutation)
 if(mutation)csrf.requireSession(request,token)
 await sessions.authenticate(token)
 return token
}

const common=new Set([
 'GET ', 'HEAD ', 'GET /content','HEAD /content','GET /revisions/:revision','HEAD /revisions/:revision','GET /lease','HEAD /lease',
 'POST /lease','POST /lease/renew','DELETE /lease','POST /uploads','POST /commits',
])
const formatRoutes:Record<string,Set<string>>={
 docx:new Set(),
 xlsx:new Set('uploads export media find recalculate pivot-definition external-links package sheet inspect range merge-sources/open merge-sources/range merge-sources/close'.split(' ')),
 pptx:new Set('open slide notes comments chart-data chart-color-schemes slide-info animations links run-links layouts custom-shows slides media-data recording clipboard-copy clipboard-paste clipboard-duplicate apply chart-edit generate-page generated-pages master-parts master-edit media undo history-batch-begin history-batch-end snapshot-restore redo uploads export recover'.split(' ')),
 pdf:new Set(('signatures/query inspect uploads page-ops page-ops/uploads image-previews/query images/query redactions/query replace-pages/uploads insert-pages/uploads stamps/uploads image-bakes/uploads image-content/uploads image-edits/uploads block-moves/uploads block-edits/uploads image-inserts/query draft-inserts/uploads draft-inserts/query text-inserts/query text-inserts/uploads apply-ops/uploads text-edits/query apply-ops/query form-fields/uploads form-values/uploads update-notes update-notes/uploads delete-annotations delete-annotations/uploads annotations/query annotate annotate/uploads edit-text edit-text/uploads rotate').split(' ')),
}
const formatPath:Record<string,string>={xlsx:'sheets',pptx:'slides',pdf:'pdf'}
const csrfPaths=new Set(['/api/v1/auth/csrf','/api/v1/auth/session-proof'])
const preferencePaths=new Set(['/api/preferences','/api/v1/preferences'])
const startScript=`
const embedded=location.search==='?dshEmbed=1'
const ticket=location.hash.slice(1)
history.replaceState(null,'',location.pathname)
if (/^[A-Za-z0-9_-]{43}$/.test(ticket)) {
 fetch('/dsh-edit/redeem',{method:'POST',credentials:'same-origin',redirect:'error',referrerPolicy:'same-origin',
   headers:{'Content-Type':'application/json'},body:JSON.stringify(embedded?{ticket,embedded:true}:{ticket})})
 .then(async r=>{
   if(!r.ok)throw Error()
   const {url}=await r.json()
   if(!/^\\/native-(docx|xlsx|pptx|pdf)\\//.test(url))throw Error()
   location.replace(url)
 }).catch(()=>{})
}
`

export function registerDshEdit(app:FastifyInstance,{transactions,csrf,origin,insecureHttpDev,nativeFormats,embedOrigins}:{
 transactions:McpPrincipalTransactions;csrf:ReturnType<typeof createCsrfService>;origin:string;insecureHttpDev?:boolean|undefined;nativeFormats:ReadonlySet<string>;embedOrigins:()=>Promise<string[]>
}) {
 const cookiePrefix=(insecureHttpDev?'':'__Host-')+'dyoffice-guest-'
 function cookieEntries(request:FastifyRequest) {
  const fields=uniqueHeader(request,'cookie')?.split(';')??[]
  return fields.map(field=>field.trim().split('=',2)).filter(([name])=>name?.startsWith(cookiePrefix))
 }
 function readCookie(request:FastifyRequest,editorId:string) {
  if(uniqueHeader(request,'authorization')!==undefined)throw authError()
  const fields=cookieEntries(request).filter(([name])=>name===cookiePrefix+editorId)
  if(fields.length!==1||!tokenPattern.test(fields[0]![1]??''))throw authError()
  return fields[0]![1]!
 }
 function guestTarget(url:URL) {
  if(url.origin!==origin||url.searchParams.get('guest')!=='1')return
  const format=nativePath.exec(url.pathname)?.[1]
  if(!format)return
  const fileId=url.searchParams.get('fileId')?.toLowerCase(),editorId=url.searchParams.get('editorId')?.toLowerCase()
  if(!fileId||!editorId||!idPattern.test(fileId)||!idPattern.test(editorId))throw authError(404)
  return {format,fileId,editorId}
 }
 // Each editor tab selects its own HttpOnly grant; a Referer alone grants no authority.
 function referrer(request:FastifyRequest) {
  const value=uniqueHeader(request,'referer')
  if(!value)return
  let url:URL
  try{url=new URL(value)}catch{return}
  return guestTarget(url)
 }
 async function verify(secret:string,target?:{fileId:string;editorId:string;format:string}) {
  return transactions.withDshEditTransaction({kind:'dsh-edit',token:secret},async(_c,p)=>{
   const edit=p.dshEdit!
   if(target&&(edit.fileId!==target.fileId||edit.editorId!==target.editorId||edit.format!==target.format))throw authError(404)
   return edit
  })
 }
 const pageHeaders=(ancestors:string)=>({'Cache-Control':'no-store','Referrer-Policy':'no-referrer','Content-Security-Policy':`default-src 'none'; script-src 'self'; connect-src 'self'; frame-ancestors ${ancestors}; base-uri 'none'; form-action 'none'`})
 app.get('/dsh-edit',async(request,reply)=>{
  const embedded=new URL(request.url,origin).searchParams.get('dshEmbed')==='1'
  const ancestors=embedded?(await embedOrigins()).join(' '):''
  return reply.headers(pageHeaders(ancestors||"'none'")).type('text/html; charset=utf-8').send(
   '<!doctype html><html lang="zh"><meta charset="utf-8"><title>DyOffice</title><script defer src="/dsh-edit/start.js"></script><p>正在打开文档。如未跳转，请从 DSH 重新打开，或请文档所有者检查编辑授权。</p></html>')
 })
 app.get('/dsh-edit/start.js',async(_request,reply)=>reply.headers(pageHeaders("'none'")).type('text/javascript; charset=utf-8').send(startScript))
 app.post('/dsh-edit/redeem',{bodyLimit:1024,schema:{body:{type:'object',additionalProperties:false,required:['ticket'],properties:{ticket:{type:'string',pattern:'^[A-Za-z0-9_-]{43}$'},embedded:{type:'boolean'}}}}},async(request,reply)=>{
  csrf.originCheck(request)
  const replacement=randomBytes(32).toString('base64url')
  const {fileId,editorId,format}=await transactions.redeemDshEditTicket((request.body as {ticket:string}).ticket,replacement)
  if(!nativeFormats.has(format))throw authError(503)
  const embedded=(request.body as {embedded?:boolean}).embedded===true && format==='docx'
  reply.header('Set-Cookie',cookiePrefix+editorId+'='+replacement+'; Path=/; HttpOnly; Max-Age=3600'+(embedded&&!insecureHttpDev?'; SameSite=None; Partitioned':'; SameSite=Lax')+(insecureHttpDev?'':'; Secure'))
  return {url:'/native-'+format+'/?fileId='+fileId+'&guest=1&editorId='+editorId+(embedded?'&dshEmbed=1':'')}
 })
 app.addHook('onRequest',async(request,reply)=>{
  if(!request.url.startsWith('/api/'))return
  const target=referrer(request)
  if(!target)return
  const route=request.routeOptions.url??'',method=request.method
  const fileRoute='/api/v1/files/:id'
  const isFile=route===fileRoute||route.startsWith(fileRoute+'/')
  const suffix=isFile?route.slice(fileRoute.length):''
  const prefix='/'+formatPath[target.format]+'/'
  if(isFile&&(request.params as {id?:string}).id?.toLowerCase()!==target.fileId)throw authError(404)
  const special=method==='GET'&&(csrfPaths.has(route)||preferencePaths.has(route))
  const allowed=special||(method==='GET'&&route==='/api/v1/capabilities')||
   ((method==='PUT'&&route==='/api/v1/uploads/:id/content')||(method==='DELETE'&&route==='/api/v1/uploads/:id'))||
   (isFile&&((target.format==='docx'&&method==='POST'&&suffix==='/word-collab')||common.has(method+' '+suffix)||(method==='POST'&&suffix.startsWith(prefix)&&formatRoutes[target.format]?.has(suffix.slice(prefix.length)))))
  if(!allowed)throw authError(404)
  const mutation=!['GET','HEAD'].includes(method)
  csrf.originCheck(request,mutation)
  const secret=readCookie(request,target.editorId),credential='dsh-edit:'+secret
  const proof=csrf.sessionToken(credential)
  if(mutation) {
   const supplied=uniqueHeader(request,'x-csrf-token')
   if(!supplied||!tokenPattern.test(supplied)||!timingSafeEqual(Buffer.from(supplied),Buffer.from(proof)))throw authError(403)
  }
  await verify(secret,target)
  if(special){
   reply.header('Cache-Control','no-store')
   return reply.send(csrfPaths.has(route)?{csrfToken:proof}:{...preferenceDefaults,showAssistant:false})
  }
  requestTokens.set(request,credential)
 })
 return async function authorizeNative(request:FastifyRequest,sessions:SessionService) {
  const url=new URL(request.url,origin)
  if(nativePath.test(url.pathname)){
   const target=guestTarget(url)
   if(!target)return sessions.authenticate(cookies(request).session??'')
   const secret=readCookie(request,target.editorId)
   await verify(secret,target)
   requestTokens.set(request,'dsh-edit:'+secret)
   return
  }
  // Static assets carry no document data. Module and CSS requests often
  // refer to another asset rather than to the editor HTML.
  const owner=cookies(request).session
  if(owner)try{return await sessions.authenticate(owner)}catch(error){if((error as {statusCode?:number}).statusCode!==401)throw error}
  const target=referrer(request)
  if(target){await verify(readCookie(request,target.editorId),target);return}
  for(const [name,secret] of cookieEntries(request))if(idPattern.test(name!.slice(cookiePrefix.length))&&tokenPattern.test(secret??'')){
   try{const edit=await verify(secret!);if(name===cookiePrefix+edit.editorId)return}
   catch(error){if((error as {statusCode?:number}).statusCode!==401)throw error}
  }
  throw authError()
 }
}
