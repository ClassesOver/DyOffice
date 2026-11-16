import type {FastifyInstance} from 'fastify'
import {createStaticAssets} from '../static-assets.mjs'
import {authError} from './modules/auth/sessions.ts'
/** Public login/chrome assets contain no user data. All personal data remains on authenticated APIs. */
export async function registerLocalShell(app:FastifyInstance,directory:string){
 const assets=await createStaticAssets({assetMode:'built',assetDirectory:directory,pages:['index.html'],cacheControl:'private, no-store'})
 for(const url of ['/','/index.html','/assets/*'])app.route({method:['GET','HEAD'],url,handler:async(request,reply)=>{
  reply.raw.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")
  const path=new URL(request.url,'http://localhost').pathname
  if(!await assets(request.raw,reply.raw,path))throw authError(404)
  reply.hijack()
 }})
}
