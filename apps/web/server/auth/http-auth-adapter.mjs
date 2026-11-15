import { isIP } from 'node:net'
import { CLEAR_SESSION_COOKIE } from './session-core.mjs'

const PATHS = new Set(['/api/v1/auth/login','/api/v1/auth/logout','/api/v1/auth/me','/api/v1/auth/csrf'])
const MAX_BODY = 4096

function singleHeader(request, name) {
  const value=request?.headers?.[name]
  if (typeof value !== 'string') return null
  if (request.headersDistinct?.[name] && request.headersDistinct[name].length !== 1) return null
  if (Array.isArray(request.rawHeaders)) {
    let n=0
    for(let i=0;i<request.rawHeaders.length;i+=2){if(String(request.rawHeaders[i]).toLowerCase()===name)n++}
    if(n!==1)return null
  }
  return value
}

async function readLoginJson(request) {
  if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(singleHeader(request,'content-type')||'')) return null
  const chunks=[]
  let size=0
  for await (const chunk of request) {
    size+=chunk.byteLength
    if (size>MAX_BODY) throw new Error('LOGIN_BODY_TOO_LARGE')
    chunks.push(chunk)
  }
  let value
  try { value=JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return null }
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(k=>!['username','password'].includes(k)) ||
      typeof value.username!=='string' || typeof value.password!=='string') return null
  return value
}

function json(response, status, body, headers={}) {
  if(response.headersSent) return response.destroy()
  response.writeHead(status,{
    'Content-Type':'application/json; charset=utf-8',
    'Cache-Control':'no-store',
    'X-Content-Type-Options':'nosniff',
    'Referrer-Policy':'no-referrer',
    'Vary':'Cookie',
    ...headers,
  })
  response.end(JSON.stringify(body))
}

/**
 * Isolated Node HTTP adapter, not yet mounted into the shared application.
 * T02 Fastify owner may adapt the same service/CSRF contracts to Fastify.
 * The configured deployment and origin MUST come from trusted server config.
 */
export function createLocalAuthHttpAdapter({ loginService, sessionService, csrfPolicy, deploymentId, trustedOrigin }) {
  if (!loginService || typeof loginService.login!=='function' ||
      !sessionService || typeof sessionService.authenticate!=='function' || typeof sessionService.revoke!=='function' ||
      !csrfPolicy || typeof csrfPolicy.verify!=='function' || typeof csrfPolicy.issue!=='function') {
    throw new TypeError('Authenticated login, session and CSRF services required')
  }
  const canonicalOrigin=new URL(trustedOrigin)
  if (canonicalOrigin.origin!==trustedOrigin ||
      !(canonicalOrigin.protocol==='https:' || (canonicalOrigin.protocol==='http:' &&
        ['localhost','127.0.0.1','[::1]'].includes(canonicalOrigin.hostname)))) {
    throw new TypeError('Trusted HTTPS origin required')
  }
  return async function handle(request,response) {
    const url=new URL(request.url,'http://localhost')
    if (!PATHS.has(url.pathname)) return false
    const method=request.method
    try {
      if (url.search || url.hash) return json(response,400,{error:'Bad request'}),true
      const isRead=url.pathname.endsWith('/me')||url.pathname.endsWith('/csrf')
      const expectedMethod=isRead?'GET':'POST'
      if(method!==expectedMethod)return json(response,405,{error:'Method not allowed'},{Allow:expectedMethod}),true
      if(!isRead && singleHeader(request,'origin')!==trustedOrigin){
        return json(response,403,{error:'Forbidden'}),true
      }
      if(url.pathname.endsWith('/login')){
        const body=await readLoginJson(request)
        if(!body)return json(response,400,{error:'Invalid login request'}),true
        // Treat socket/authorized proxy address as trusted identity input. Never
        // derive IP directly from client X-Forwarded-For.
        const ip=request.socket?.remoteAddress
        if(!isIP(ip))return json(response,503,{error:'Service unavailable'}),true
        const result=await loginService.login({...body,ipAddress:ip})
        if(result?.ok===true){
          return json(response,200,{ok:true},{'Set-Cookie':result.cookie}),true
        }
        const status=result?.code==='RATE_LIMITED'?429:401
        return json(response,status,{error:status===429?'Too many login attempts':'Invalid credentials'}),true
      }
      const principal=await sessionService.authenticate(request,{deploymentId})
      if(!principal)return json(response,401,{error:'Unauthorized'}),true
      if(url.pathname.endsWith('/me')){
        return json(response,200,{userId:principal.userId,roles:principal.roles,expiresAt:principal.expiresAt}),true
      }
      if(url.pathname.endsWith('/csrf')){
        return json(response,200,{csrfToken:csrfPolicy.issue(principal)}),true
      }
      if(!csrfPolicy.verify(request,principal))return json(response,403,{error:'Forbidden'}),true
      await sessionService.revoke(request,{deploymentId})
      return json(response,200,{ok:true},{'Set-Cookie':CLEAR_SESSION_COOKIE}),true
    }catch(error){
      // The HTTP boundary never reveals database, hash or input details.
      if(response.headersSent){response.destroy();return true}
      json(response,error instanceof Error&&error.message==='LOGIN_BODY_TOO_LARGE'?413:503,
        {error:error instanceof Error&&error.message==='LOGIN_BODY_TOO_LARGE'?'Request too large':'Service unavailable'})
      return true
    }
  }
}
