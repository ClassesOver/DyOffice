import type {FastifyInstance} from 'fastify'
import {authError} from '../auth/sessions.ts'
import {cookies} from '../auth/csrf.ts'
import type {createStaticAssets} from '../../../static-assets.mjs'
/** Built-only experimental assets: authenticate before lookup, including HEAD. */
export function registerProbeAssets(app:FastifyInstance,assets:Awaited<ReturnType<typeof createStaticAssets>>,authorize:(token:string)=>Promise<void>){
 app.route({method:['GET','HEAD'],url:'/admin/provider-probe/*',onRequest:async(request,reply)=>{
  reply.raw.setHeader('Cache-Control','private, no-store')
  reply.raw.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
  const token=cookies(request).session
  if(!token)throw authError()
  await authorize(token)
 },handler:async(request,reply)=>{
  const path=new URL(request.url,'http://localhost').pathname.slice('/admin/provider-probe'.length)
  if(path!=='/'&&path!=='/index.html'&&!/^\/assets\/[A-Za-z0-9_.\/-]+$/.test(path))throw authError(404)
  if(!await assets(request.raw,reply.raw,path))throw authError(404)
  reply.hijack()
 }})
}
