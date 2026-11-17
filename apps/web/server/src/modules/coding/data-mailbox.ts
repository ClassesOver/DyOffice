import {mkdtemp,open,readdir,rename,rm} from 'node:fs/promises'
import {constants} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import type {FastifyInstance} from 'fastify'

/** Linux's network-disabled sandbox also denies Unix connect. This task-only
 * file transport forwards HTTP envelopes to the exact same authenticated API.
 * It never interprets SQL, performs analysis or accepts filesystem destinations.
 */
export async function createHarnessDataMailbox(app:FastifyInstance,taskId:string) {
  const directory=await mkdtemp(join(tmpdir(),'office-data-'))
  const prefix='/api/v1/agents/tasks/'+taskId+'/data/'
  let stopped=false,polling=false
  const active=new Set<Promise<void>>()
  async function processRequest(name:string) {
    const id=name.slice(0,-8),processing=join(directory,id+'.processing')
    try {
      await rename(join(directory,name),processing)
      const file=await open(processing,constants.O_RDONLY|constants.O_NOFOLLOW)
      let envelope:{path:string;method:string;headers:Record<string,string>;body?:string}
      try {
        const stat=await file.stat()
        if(!stat.isFile()||stat.nlink!==1||stat.size>12*1024*1024+65536)throw Error('Invalid envelope')
        const bytes=Buffer.alloc(stat.size+1),read=await file.read(bytes,0,bytes.length,0)
        if(read.bytesRead!==stat.size)throw Error('Invalid envelope')
        envelope=JSON.parse(bytes.subarray(0,read.bytesRead).toString('utf8'))
      } finally {await file.close()}
      if(!envelope||typeof envelope.path!=='string'||!envelope.path.startsWith(prefix)||
        !((envelope.method==='POST'&&envelope.path===prefix+'execute')||
          (envelope.method==='GET'&&/^results\/[A-Za-z0-9_-]{1,128}\/content$/.test(envelope.path.slice(prefix.length))))||
        !envelope.headers||typeof envelope.headers.authorization!=='string'||
        (envelope.body!==undefined&&typeof envelope.body!=='string'))throw Error('Invalid envelope')
      const result=await app.inject({method:envelope.method as 'GET'|'POST',url:envelope.path,
        headers:{authorization:envelope.headers.authorization,'content-type':'application/json'},
        ...(envelope.body===undefined?{}:{payload:envelope.body})})
      if(stopped)return
      const headers:Record<string,string>={}
      for(const key of ['content-type','content-length','x-content-sha256','x-snapshot-sha256']) {
        const value=result.headers[key];if(typeof value==='string')headers[key]=value
      }
      await respond(id,{status:result.statusCode,headers,bytesBase64:result.rawPayload.toString('base64')})
    } catch {
      if(!stopped)await respond(id,{status:403,headers:{'content-type':'application/json'},bytesBase64:Buffer.from('{"error":"Harness data unavailable"}').toString('base64')}).catch(()=>{})
    } finally {await rm(processing,{force:true}).catch(()=>{})}
  }
  async function respond(id:string,value:unknown) {
    const temporary=join(directory,randomUUID()+'.tmp')
    try {
      const file=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600)
      try {await file.writeFile(JSON.stringify(value))}finally{await file.close()}
      await rename(temporary,join(directory,id+'.response'))
    } finally {await rm(temporary,{force:true}).catch(()=>{})}
  }
  const timer=setInterval(()=>{
    if(stopped||polling||active.size>=2)return
    polling=true
    void readdir(directory).then(names=>{
      if(stopped)return
      for(const name of names.filter(name=>/^[0-9a-f-]{36}\.request$/.test(name)).slice(0,16)) {
        if(active.size>=2)break
        const operation=processRequest(name);active.add(operation)
        void operation.finally(()=>active.delete(operation))
      }
    }).catch(()=>{}).finally(()=>{polling=false})
  },25)
  timer.unref()
  return {directory,async close(){stopped=true;clearInterval(timer);await Promise.allSettled([...active]);await rm(directory,{recursive:true,force:true})}}
}
