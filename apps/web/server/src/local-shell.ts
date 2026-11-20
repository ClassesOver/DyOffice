import type {FastifyInstance} from 'fastify'
import {stat} from 'node:fs/promises'
import {join} from 'node:path'
import {createStaticAssets} from '../static-assets.mjs'
import {servePdfFonts} from '../src/pdf/fonts.mjs'
import {authError} from './modules/auth/sessions.ts'
export function dshEmbedOrigin(value?:string) {
 if(!value)return undefined
 const url=new URL(value)
 if(url.origin!==value||!(url.protocol==='https:'||url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)))throw new Error('Invalid DyOffice DSH embed origin')
 return url.origin
}
/** Public login/chrome assets contain no user data. All personal data remains on authenticated APIs. */
export async function registerLocalShell(app:FastifyInstance,directory:string,embedOrigin?:string){
 const allowed=dshEmbedOrigin(embedOrigin)
 const options={assetMode:'built',assetDirectory:directory,pages:['index.html'],cacheControl:'private, no-store'}
 const buildStamp=async()=>{const info=await stat(join(directory,'.vite/manifest.json'),{bigint:true});return `${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`}
 let stamp=await buildStamp(),assets=await createStaticAssets(options)
 let refreshing:Promise<void>|undefined
 const refresh=async()=>{
  if(refreshing)return refreshing
  if(await buildStamp()===stamp)return
  if(refreshing)return refreshing
  refreshing=(async()=>{
   const nextStamp=await buildStamp()
   const nextAssets=await createStaticAssets(options)
   assets=nextAssets;stamp=nextStamp
  })()
  try{await refreshing}finally{refreshing=undefined}
 }
 app.route({method:['GET','HEAD'],url:'/pdfjs/*',handler:async(request,reply)=>{if(!await servePdfFonts(request.raw,reply.raw,new URL(request.url,'http://localhost').pathname))throw authError(404);reply.hijack()}})
 for(const url of ['/','/index.html','/assets/*'])app.route({method:['GET','HEAD'],url,handler:async(request,reply)=>{
  const target=new URL(request.url,'http://localhost'),path=target.pathname
  const ancestor=allowed&&(path==='/'||path==='/index.html')&&target.searchParams.get('dshEmbed')==='1'?allowed:"'none'"
  reply.raw.setHeader('Content-Security-Policy',`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors ${ancestor}`)
  // A local rebuild replaces HTML and hashed assets while the server stays alive.
  // Refresh only through the same validated manifest allowlist used at startup.
  await refresh()
  if(!await assets(request.raw,reply.raw,path))throw authError(404)
  reply.hijack()
 }})
}
