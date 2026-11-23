import {validateOfficeEmbedOrigins} from '../../../../packages/web-contracts/src/settings.ts'
import type {FastifyInstance} from 'fastify'
import {stat} from 'node:fs/promises'
import {join} from 'node:path'
import {createStaticAssets} from '../static-assets.mjs'
import {authError} from './modules/auth/sessions.ts'
export function dshEmbedOrigin(value?:string) {
 if(!value)return undefined
 return validateOfficeEmbedOrigins([value])[0]
}
export type OfficeEmbedOrigins = () => Promise<string[]>
/** Public login/chrome assets contain no user data. All personal data remains on authenticated APIs. */
export async function registerLocalShell(app:FastifyInstance,directory:string,embedOrigin?:string | OfficeEmbedOrigins){
 const origins:OfficeEmbedOrigins=typeof embedOrigin==='function'?embedOrigin:async()=>embedOrigin?[dshEmbedOrigin(embedOrigin)!]:[]
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
 for(const url of ['/','/index.html','/assets/*'])app.route({method:['GET','HEAD'],url,handler:async(request,reply)=>{
  const target=new URL(request.url,'http://localhost'),path=target.pathname
  const embed=(path==='/'||path==='/index.html')&&target.searchParams.get('dshEmbed')==='1'
  const allowed=embed?(await origins()).join(' '):''
  const ancestor=allowed||"'none'"
  reply.raw.setHeader('Content-Security-Policy',`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors ${ancestor}`)
  // A local rebuild replaces HTML and hashed assets while the server stays alive.
  // Refresh only through the same validated manifest allowlist used at startup.
  await refresh()
  if(!await assets(request.raw,reply.raw,path))throw authError(404)
  reply.hijack()
 }})
}
