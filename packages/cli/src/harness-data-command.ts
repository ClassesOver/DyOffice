import {constants} from 'node:fs'
import {open,rename,unlink} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import {setTimeout as pause} from 'node:timers/promises'
import {request as httpRequest} from 'node:http'
import {isAbsolute,resolve,join} from 'node:path'
import {Readable} from 'node:stream'
import {HARNESS_DATA_MAX_METADATA_BYTES} from '../../web-contracts/src/harness-data.ts'
import {SOURCE_RESULT_MAX_BYTES} from '../../web-contracts/src/source-results.ts'
import {SOURCE_QUERY_REQUEST_TIMEOUT_MS,sourceQueryBatchSize} from '../../web-contracts/src/source-query-batch.ts'
import {flagString,type ParsedArgs} from './args'
import {createHarnessDataClient,harnessDataRequestLimit} from './harness-data'
import {CliError,EXIT,type CommandResult} from './result'

export const HARNESS_DATA_USAGE='data execute <operation> [--args <json> | --args-file <file>] | data receipt <commandId> | data manifest <resultId> | data download <resultId> --out <file>'

/** 仅切换本地传输，HTTP 路径、任务凭据、响应与完整性校验完全复用。
 * socket 地址来自可信启动配置，不接受模型通过操作参数指定。 */
function socketFetch(socketPath:string):typeof fetch {
  if(!isAbsolute(socketPath)||socketPath.includes('\0'))throw Error('Invalid task transport')
  return async(input,init)=>{
    const url=new URL(String(input))
    if(init?.body!==undefined&&typeof init.body!=='string')throw Error('Invalid task request')
    return new Promise<Response>((resolveResponse,reject)=>{
      const request=httpRequest({socketPath,path:url.pathname,method:init?.method??'GET',
        headers:Object.fromEntries(new Headers(init?.headers).entries()),...(init?.signal?{signal:init.signal}:{})},response=>{
        const headers=new Headers()
        for(const name of ['content-type','content-length','x-content-sha256','x-snapshot-sha256']) {
          const value=response.headers[name]
          if(typeof value==='string')headers.set(name,value)
        }
        try {resolveResponse(new Response(Readable.toWeb(response) as ReadableStream<Uint8Array>,{status:response.statusCode??500,headers}))}
        catch(error){response.destroy();reject(error)}
      })
      request.once('error',reject)
      request.end(init?.body)
    })
  }
}

/** Linux 沙箱禁止 connect(2)，通过任务专属文件邮箱传输相同 HTTP 请求。
 * 业务协议、Bearer、数据完整性和返回上限仍由同一客户端校验。 */
function mailboxFetch(directory:string,queryCount?:number):typeof fetch {
  if(!isAbsolute(directory)||directory.includes('\0'))throw Error('Invalid task transport')
  return async(input,init)=>{
    const id=randomUUID(),temporary=join(directory,id+'.tmp'),requestPath=join(directory,id+'.request'),responsePath=join(directory,id+'.response')
    const controller=new AbortController(),abort=()=>controller.abort()
    init?.signal?.addEventListener('abort',abort,{once:true})
    if(init?.signal?.aborted)abort()
    const timer=queryCount===undefined?setTimeout(abort,SOURCE_QUERY_REQUEST_TIMEOUT_MS):undefined
    const maxBodyBytes=init?.method==='GET'?SOURCE_RESULT_MAX_BYTES:(queryCount??1)*HARNESS_DATA_MAX_METADATA_BYTES
    const maxEncodedLength=4*Math.ceil(maxBodyBytes/3)
    // Reserve space for the HTTP headers, status and JSON framing.
    const maxEnvelopeBytes=maxEncodedLength+16*1024
    let created=false
    try {
      if(controller.signal.aborted)throw Error('Task request cancelled')
      const url=new URL(String(input))
      if(init?.body!==undefined&&typeof init.body!=='string')throw Error('Invalid task request')
      const file=await open(temporary,'wx',0o600);created=true
      try {await file.writeFile(JSON.stringify({path:url.pathname,method:init?.method??'GET',headers:Object.fromEntries(new Headers(init?.headers).entries()),...(init?.body===undefined?{}:{body:init.body})}))}finally{await file.close()}
      await rename(temporary,requestPath)
      for(;;) {
        if(controller.signal.aborted)throw Error('Task request cancelled')
        let responseFile
        try {responseFile=await open(responsePath,constants.O_RDONLY|constants.O_NOFOLLOW)}
        catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
        if(responseFile) {
          let payload:unknown
          try {
            const info=await responseFile.stat()
            if(!info.isFile()||info.nlink!==1||info.size>maxEnvelopeBytes)throw Error('Invalid task response')
            const buffer=Buffer.alloc(info.size+1)
            let length=0
            for(;;){const read=await responseFile.read(buffer,length,buffer.length-length,null);length+=read.bytesRead;if(!read.bytesRead||length===buffer.length)break}
            if(length!==info.size)throw Error('Invalid task response')
            payload=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,length)))
          } finally {await responseFile.close()}
          if(!payload||typeof payload!=='object'||Array.isArray(payload))throw Error('Invalid task response')
          const value=payload as {status:number;headers:Record<string,string>;bytesBase64:string}
          if(!Number.isInteger(value.status)||value.status<200||value.status>599||typeof value.bytesBase64!=='string'||value.bytesBase64.length>maxEncodedLength||
            !value.headers||typeof value.headers!=='object'||Array.isArray(value.headers)||Object.values(value.headers).some(item=>typeof item!=='string'))throw Error('Invalid task response')
          const bytes=Buffer.from(value.bytesBase64,'base64')
          if(bytes.length>maxBodyBytes||bytes.toString('base64')!==value.bytesBase64)throw Error('Invalid task response')
          return new Response(bytes,{status:value.status,headers:value.headers})
        }
        await pause(25,undefined,{signal:controller.signal})
      }
    } finally {
      clearTimeout(timer);init?.signal?.removeEventListener('abort',abort)
      if(created)await Promise.all([temporary,requestPath,responsePath].map(path=>unlink(path).catch(()=>{})))
    }
  }
}

/** 命令和内置小 helper 共用入口，不在 argv 接收授权秘密。 */
export async function runHarnessDataCommand(args:ParsedArgs,options:{cwd:string;env:NodeJS.ProcessEnv;signal?:AbortSignal}):Promise<CommandResult> {
  const env={...options.env}
  if(!env.OFFICE_HARNESS_DATA_CREDENTIAL&&env.OFFICE_HARNESS_DATA_CREDENTIAL_FILE) {
    try {
      const file=await open(env.OFFICE_HARNESS_DATA_CREDENTIAL_FILE,constants.O_RDONLY|constants.O_NOFOLLOW)
      try {
        const info=await file.stat()
        if(!info.isFile()||info.nlink!==1||info.size>2048)throw Error('Invalid credential')
        const bytes=Buffer.alloc(2049),read=await file.read(bytes,0,bytes.length,0)
        if(read.bytesRead>2048)throw Error('Invalid credential')
        env.OFFICE_HARNESS_DATA_CREDENTIAL=bytes.subarray(0,read.bytesRead).toString('utf8')
      } finally {await file.close()}
    } catch {throw new CliError(EXIT.app,'Office task data authorization is unavailable',undefined,{reason:'app_unavailable'})}
  }
  const action=args.positionals[0],identifier=args.positionals[1]
  const usage=()=>new CliError(EXIT.usage,HARNESS_DATA_USAGE,undefined,{reason:'invalid_argument'})
  if(!['execute','manifest','download','receipt'].includes(action??'')||!identifier||args.positionals.length!==2)throw usage()
  const allowed=new Set(['json',...(action==='execute'?['args','args-file']:action==='download'?['out']:[])])
  if(Object.keys(args.flags).some(key=>!allowed.has(key)))throw usage()
  if(!env.OFFICE_HARNESS_DATA_URL||!env.OFFICE_HARNESS_TASK_ID||!env.OFFICE_HARNESS_DATA_CREDENTIAL)
    throw new CliError(EXIT.app,'Office task data authorization is unavailable',undefined,{reason:'app_unavailable'})
  let pendingMailbox:Promise<Response>|undefined
  try {
    const {OFFICE_HARNESS_DATA_URL:baseUrl,OFFICE_HARNESS_TASK_ID:taskId,OFFICE_HARNESS_DATA_CREDENTIAL:credential}=env
    const client=(queryCount?:number)=>{
      let fetchImpl:typeof fetch|undefined
      if(env.OFFICE_HARNESS_DATA_MAILBOX){
        const send=mailboxFetch(env.OFFICE_HARNESS_DATA_MAILBOX,queryCount)
        fetchImpl=(input,init)=>pendingMailbox=send(input,init)
      }else if(env.OFFICE_HARNESS_DATA_SOCKET)fetchImpl=socketFetch(env.OFFICE_HARNESS_DATA_SOCKET)
      return createHarnessDataClient({baseUrl,taskId,credential,fetchImpl})
    }
    if(action==='download') {
      const output=flagString(args,'out')
      if(!output)throw usage()
      const result=await client().download(identifier,resolve(options.cwd,output),options.signal)
      return {summary:'Frozen result downloaded and verified',outputPath:result.destination,detail:{...result}}
    }
    if(action==='receipt')return {summary:'Committed analysis receipt recovered',detail:await client().receipt<Record<string,unknown>>(identifier,options.signal)}
    if(action==='manifest')return {summary:'Frozen result manifest',detail:await client().manifest<Record<string,unknown>>(identifier,options.signal)}
    const inputFile=flagString(args,'args-file')
    if(args.flags['args-file']!==undefined&&!inputFile||inputFile&&args.flags.args!==undefined)throw usage()
    let raw=flagString(args,'args')??'{}'
    if(inputFile) {
      const file=await open(resolve(options.cwd,inputFile),constants.O_RDONLY|constants.O_NOFOLLOW)
      try {
        if(!(await file.stat()).isFile())throw usage()
        const buffer=Buffer.alloc(harnessDataRequestLimit(identifier)+1)
        let length=0
        for(;;){const read=await file.read(buffer,length,buffer.length-length,null);length+=read.bytesRead;if(!read.bytesRead||length===buffer.length)break}
        if(length===buffer.length)throw usage()
        raw=new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,length))
      } finally {await file.close()}
    }
    if(Buffer.byteLength(raw)>harnessDataRequestLimit(identifier))throw usage()
    const parameters:unknown=JSON.parse(raw)
    if(!parameters||typeof parameters!=='object'||Array.isArray(parameters))throw usage()
    const data=client(identifier==='sources.query'?(sourceQueryBatchSize(identifier,parameters)??1):undefined)
    return {summary:'Office task data operation completed',detail:await data.execute<Record<string,unknown>>(identifier,parameters as Record<string,unknown>,options.signal)}
  } catch(error) {
    if(error instanceof CliError)throw error
    throw new CliError(EXIT.app,options.signal?.aborted?'Office task data operation cancelled':'Office task data operation unavailable',undefined,{reason:'app_unavailable'})
  } finally {await pendingMailbox?.catch(()=>{})}
}
