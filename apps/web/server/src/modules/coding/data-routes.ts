import {createHash} from 'node:crypto'
import type {FastifyInstance} from 'fastify'
import type {createHarnessDataAccess} from './data-access.ts'
import type {createHarnessArtifacts} from './artifacts.ts'
import {cookies,type createCsrfService} from '../auth/csrf.ts'

/** Task bearer only: Office cookies and datasource credentials never enter a harness. */
export function registerHarnessDataRoutes(app:FastifyInstance,data:ReturnType<typeof createHarnessDataAccess>) {
  const credential=(headers:{authorization?:string})=>{
    const match=/^Bearer ([A-Za-z0-9_-]{43})$/.exec(headers.authorization??'')
    if(!match)throw Object.assign(Error('Harness data unavailable'),{statusCode:403})
    return match[1]!
  }
  app.post<{Params:{taskId:string}}>('/api/v1/agents/tasks/:taskId/data/execute',{bodyLimit:12*1024*1024},async(request,reply)=>{
    reply.header('Cache-Control','private, no-store')
    const body=request.body as Record<string,unknown>
    if(!body||Array.isArray(body)||Object.keys(body).some(k=>!['operation','arguments'].includes(k))||typeof body.operation!=='string'||body.operation==='results.download')throw Object.assign(Error('Invalid data request'),{statusCode:400})
    return data.execute(request.params.taskId,credential(request.headers),body.operation,body.arguments)
  })
  app.get<{Params:{taskId:string;resultId:string}}>('/api/v1/agents/tasks/:taskId/data/results/:resultId/content',async(request,reply)=>{
    const result=await data.download(request.params.taskId,credential(request.headers),request.params.resultId)
    const bytes=Buffer.from(result.bytes)
    return reply.header('Cache-Control','private, no-store').header('Content-Type','application/json')
      .header('X-Content-SHA256',createHash('sha256').update(bytes).digest('hex'))
      .header('X-Snapshot-SHA256',result.sha256).send(bytes)
  })
  app.addHook('preClose',async()=>data.dispose())
}

export function registerAnalysisDeliveryRoutes(app:FastifyInstance,artifacts:ReturnType<typeof createHarnessArtifacts>,csrf:Pick<ReturnType<typeof createCsrfService>,'requireSessionRead'|'originCheck'>) {
  const token=(request:Parameters<typeof cookies>[0])=>{
    const value=cookies(request).session??''
    csrf.requireSessionRead(request,value)
    return value
  }
  app.get<{Params:{commandId:string}}>('/api/v1/agents/deliveries/:commandId',async(request,reply)=>{
    reply.header('Cache-Control','private, no-store')
    return artifacts.receipt(token(request),request.params.commandId)
  })
  app.get<{Params:{artifactId:string}}>('/api/v1/agents/artifacts/:artifactId/content',async(request,reply)=>{
    csrf.originCheck(request,false)
    // Bound renderer downloads send the original proof; absent headers retain
    // the existing owner-authenticated attachment navigation behavior.
    if(request.headers['x-csrf-token']!==undefined)csrf.requireSessionRead(request,cookies(request).session??'')
    const result=await artifacts.download(cookies(request).session??'',request.params.artifactId)
    return reply.header('Cache-Control','private, no-store').header('Content-Type','application/octet-stream')
      .header('Content-Disposition',"attachment; filename*=UTF-8''"+encodeURIComponent(result.artifact.name).replace(/[!'()*]/g,char=>'%'+char.charCodeAt(0).toString(16).toUpperCase()))
      .header('Content-Security-Policy',"sandbox; default-src 'none'").header('X-Content-Type-Options','nosniff')
      .header('X-Content-SHA256',result.artifact.sha256).send(result.bytes)
  })
}
