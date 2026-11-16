import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { request } from 'node:https'

export type PinnedJsonTarget = Readonly<{ url: string; addresses: readonly string[]; ca?: string }>
const failure = () => new Error('Source request failed')
function invalid(): never { throw new Error('Invalid egress configuration') }
function address(value: string): string {
  const family=isIP(value)
  if (!family) invalid()
  return family===6 ? new URL(`http://[${value}]/`).hostname.slice(1,-1) : value
}
function forbidden(ip: string): boolean {
  // Metadata/link-local, unspecified and multicast are never approved targets.
  // Other private addresses require exact explicit operator approval, not a CIDR wildcard.
  if(isIP(ip)===4){const [a,b]=ip.split('.').map(Number);return a===0 || a===169&&b===254 || a>=224 || ip==='100.100.100.200'}
  return ip==='fd00:ec2::254' || ip==='::' || ip.startsWith('fe8') || ip.startsWith('fe9') || ip.startsWith('fea') || ip.startsWith('feb') || ip.startsWith('ff') || ip.startsWith('::ffff:')
}
/** Construct from trusted server-side configuration only, never request JSON.
 * This transport does NOT authorize source access. Call only after a source grant check.
 * No redirects, ambient proxy/agent, credential forwarding or caller-selected URL.
 */
export function createPinnedJsonClient(targets: Readonly<Record<string,PinnedJsonTarget>>, {timeoutMs=10_000,maxBytes=1_000_000}: {timeoutMs?:number;maxBytes?:number}={}) {
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>30_000||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>8_000_000)invalid()
  const configs=new Map<string,{url:URL;addresses:readonly string[];ca?:string}>()
  for(const [id,target] of Object.entries(targets)){
    let url:URL;try{url=new URL(target.url)}catch{invalid()}
    if(!id || url.protocol!=='https:' || url.username || url.password || url.hash || !Array.isArray(target.addresses)||!target.addresses.length||target.addresses.length>32)invalid()
    const addresses=target.addresses.map(address)
    if(addresses.some(forbidden) || (target.ca!==undefined && typeof target.ca!=='string'))invalid()
    configs.set(id,{url,addresses:Object.freeze(addresses),ca:target.ca})
  }
  return Object.freeze({
    async get(sourceId:string,signal?:AbortSignal):Promise<unknown>{
      const config=configs.get(sourceId)
      if(!config||signal?.aborted)throw failure()
      const controller=new AbortController()
      const cancel=()=>controller.abort()
      signal?.addEventListener('abort',cancel,{once:true})
      const timer=setTimeout(cancel,timeoutMs)
      let rejectAbort:(()=>void)|undefined
      try{
        const aborted=new Promise<never>((_,reject)=>{rejectAbort=()=>reject(failure());controller.signal.addEventListener('abort',rejectAbort,{once:true})})
        const operation=(async()=>{
          const hostname=config.url.hostname.replace(/^\[|\]$/g,'')
          const answers=isIP(hostname)?[{address:hostname,family:isIP(hostname)}]:await lookup(hostname,{all:true,verbatim:true})
          if(controller.signal.aborted||!answers.length||answers.some(a=>!config.addresses.includes(address(a.address))))throw failure()
          const pinned=address(answers[0].address)
          return await new Promise<unknown>((resolve,reject)=>{
            const req=request({protocol:'https:',hostname:pinned,port:config.url.port||443,path:config.url.pathname+config.url.search,method:'GET',headers:{host:config.url.host,accept:'application/json','accept-encoding':'identity'},servername:isIP(hostname)?undefined:hostname,rejectUnauthorized:true,ca:config.ca,agent:false,signal:controller.signal},res=>{
              const type=res.headers['content-type']?.split(';',1)[0].trim().toLowerCase()
              if(res.statusCode!==200 || type!=='application/json' || res.headers['content-encoding'] && res.headers['content-encoding']!=='identity'){res.destroy();reject(failure());return}
              const chunks:Buffer[]=[];let bytes=0
              res.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>maxBytes){res.destroy();reject(failure())}else chunks.push(chunk)})
              res.on('error',()=>reject(failure()))
              res.on('aborted',()=>reject(failure()))
              res.on('end',()=>{try{const text=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));resolve(JSON.parse(text))}catch{reject(failure())}})
            })
            req.on('error',()=>reject(failure()));req.end()
          })
        })()
        return await Promise.race([operation,aborted])
      }catch{throw failure()}finally{
        clearTimeout(timer);signal?.removeEventListener('abort',cancel)
        if(rejectAbort)controller.signal.removeEventListener('abort',rejectAbort)
      }
    },
  })
}
