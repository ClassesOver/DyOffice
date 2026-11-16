import { spawn,execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir,readFile,writeFile,copyFile,chmod,open,rm,lstat } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { constants } from 'node:fs'
import { createHash,randomUUID } from 'node:crypto'
import { join,isAbsolute } from 'node:path'
import { SandboxError,type SandboxSession,type SandboxLimits } from './contracts.ts'
const exec=promisify(execFile),MAX=32*1024*1024
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const commands=new Set(['open','close','save_archive','read_range','read_formula_cells','read_row_outline','recalc_cells','probe','network','pids','sleep','busy','allocate','flood','output','symlink','park'])
const environment={ PATH: '/usr/bin:/bin',LANG: 'C.UTF-8',SYSTEMD_COLORS: '0',SYSTEMD_PAGER: 'cat' }
let active=0,memory=0
async function bounded(file: FileHandle,size: number) {
  const buffer=Buffer.allocUnsafe(size+1);let length=0
  while(length<buffer.length){const part=await file.read(buffer,length,buffer.length-length,null);if(part.bytesRead===0)break;length+=part.bytesRead}
  if(length!==size)throw new SandboxError('OUTPUT_LIMIT')
  return buffer.subarray(0,length)
}
export function createHostProcess({ binary,sha256,deploymentId,allowedCommands,limits={} }: { binary: string; sha256: string; deploymentId: string; allowedCommands: readonly string[]; limits?: SandboxLimits }) {
  if (process.env.NODE_ENV==='production' || process.getuid?.()!==0) throw new SandboxError('HOST_BACKEND_UNAVAILABLE')
  if (!isAbsolute(binary) || !/^[a-f0-9]{64}$/.test(sha256) || !UUID.test(deploymentId)) throw new SandboxError('UNTRUSTED_BINARY')
  const p={ memoryMiB: 512,pids: 64,cpuSeconds: 15,cpus: 1,wallMs: 30000,protocolBytes: 8*1024*1024,outputBytes: MAX,...limits }
  for (const [key,min,max] of [['memoryMiB',64,1024],['pids',8,128],['cpuSeconds',1,120],['wallMs',500,180000],['protocolBytes',1024,16*1024*1024],['outputBytes',1,MAX]] as const) if (!Number.isInteger(p[key]) || p[key]<min || p[key]>max) throw new SandboxError('INVALID_LIMIT')
  if (!Number.isFinite(p.cpus) || p.cpus<0.25 || p.cpus>2 || !allowedCommands.length || allowedCommands.some(c => !commands.has(c))) throw new SandboxError('INVALID_POLICY')
  const permitted=new Set(allowedCommands)
  return {
    deploymentId,
    async run<T>(input: Uint8Array,execute: (session: SandboxSession) => Promise<T>,{signal}: {signal?: AbortSignal}={}): Promise<T> {
      if (!(input instanceof Uint8Array) || input.length<1 || input.length>MAX) throw new SandboxError('INPUT_LIMIT')
      if (signal?.aborted) throw new SandboxError('ABORTED')
      if (active>=2 || memory+p.memoryMiB>1024) throw new SandboxError('SANDBOX_BUSY')
      active++; memory+=p.memoryMiB
      const bytes=Buffer.from(input),id=randomUUID(),stem='dyoffice-'+deploymentId+'-'+id,unit=stem+'.service',base=join('/var/tmp',stem),root=join(base,'root')
      const transfers=new Set<Promise<unknown>>()
      const pending=new Map<string,{ resolve(value: unknown): void; reject(error: Error): void }>()
      let reason: SandboxError | undefined,work: FileHandle | undefined,child: ReturnType<typeof spawn> | undefined,normal=false,line='',protocol=0,stderr=0,sequence=0
      let interrupt!: (error: Error) => void
      const interrupted=new Promise<never>((_,reject) => { interrupt=reject }); void interrupted.catch(()=>{})
      const systemctl=(args: string[]) => exec('/usr/bin/systemctl',args,{ env: environment,timeout: 5000,maxBuffer: 65536 })
      const state=async () => {
        const text=(await systemctl(['show',unit,'--property=MainPID,InvocationID,ControlGroup,ActiveState,Result,ExecMainStatus'])).stdout
        return Object.fromEntries(text.trim().split('\n').map(row => { const i=row.indexOf('='); return [row.slice(0,i),row.slice(i+1)] }))
      }
      const fail=(error: SandboxError) => { if (reason) return; reason=error; for (const waiter of pending.values()) waiter.reject(error); pending.clear(); interrupt(error); void systemctl(['kill','--kill-whom=all','--signal=KILL',unit]).catch(()=>{}) }
      const check=() => { if(reason) throw reason; if(signal?.aborted) throw new SandboxError('ABORTED') }
      const abort=()=>fail(new SandboxError('ABORTED'))
      signal?.addEventListener('abort',abort,{ once:true })
      const timer=setTimeout(()=>fail(new SandboxError('SANDBOX_TIMEOUT')),p.wallMs)
      const initializing=(async()=>{
        const native=await open(binary,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK)
        let source: Buffer
        try { const stat=await native.stat(); if(!stat.isFile()||stat.size<1||stat.size>64*1024*1024)throw new SandboxError('UNTRUSTED_BINARY'); source=await bounded(native,stat.size) } finally { await native.close() }
        if (source.length>64*1024*1024 || createHash('sha256').update(source).digest('hex')!==sha256) throw new SandboxError('UNTRUSTED_BINARY')
        await mkdir(base,{ mode: 0o700 }); check()
        for(const directory of ['bin','work','tmp','var/tmp','proc','sys','dev']) await mkdir(join(root,directory),{ recursive:true,mode: 0o755 })
        await writeFile(join(root,'bin/native'),source,{mode:0o555})
        const deps=(await exec('/usr/bin/ldd',[join(root,'bin/native')],{ env:environment,timeout:5000,maxBuffer:65536 })).stdout
        if(deps.includes('not found')) throw new SandboxError('MISSING_NATIVE_DEPENDENCY')
        const libraries=[...new Set(deps.match(/\/[^\s()]+/g) ?? [])]
        for(const path of libraries) { if(!isAbsolute(path)) throw new SandboxError('MISSING_NATIVE_DEPENDENCY'); const dest=join(root,path); await mkdir(join(dest,'..'),{recursive:true}); await copyFile(path,dest); await chmod(dest,0o555) }
        check()
        const properties=['DynamicUser=yes','User=dyjob'+id.replaceAll('-','').slice(0,24),'RootDirectory='+root,'WorkingDirectory=/work','MountAPIVFS=yes','ProtectSystem=strict','ProtectHome=yes','TemporaryFileSystem=/work:rw,nosuid,nodev,noexec,size=128M,mode=0711 /tmp:rw,nosuid,nodev,noexec,size=16M,mode=1777','ReadWritePaths=/work /tmp','PrivateNetwork=yes','PrivateDevices=yes','ProtectProc=invisible','ProcSubset=pid','ProtectControlGroups=yes','ProtectKernelTunables=yes','NoNewPrivileges=yes','CapabilityBoundingSet=','RestrictAddressFamilies=AF_UNIX','SystemCallFilter=@system-service','UMask=0077','KillMode=control-group','TimeoutStopSec=2','MemoryMax='+p.memoryMiB+'M','MemorySwapMax=0','OOMPolicy=kill','TasksMax='+p.pids,'CPUQuota='+Math.round(p.cpus*100)+'%','LimitCPU='+p.cpuSeconds+':'+(p.cpuSeconds+1),'LimitCORE=0','LimitFSIZE='+MAX,'LimitNOFILE=64','RuntimeMaxSec='+p.wallMs+'ms','Environment=LANG=C.UTF-8 TMPDIR=/work PATH=/bin']
        child=spawn('/usr/bin/systemd-run',['--quiet','--pipe','--wait','--service-type=exec','--unit='+stem,...properties.flatMap(value=>['--property='+value]),'/bin/native'],{env:environment,stdio:['pipe','pipe','pipe']})
        const running=child
        running.stdin!.on('error',()=>{if(!normal)fail(new SandboxError('NATIVE_FAILED'))})
        running.stdout!.setEncoding('utf8').on('data',(chunk:string)=>{
          protocol+=Buffer.byteLength(chunk); if(protocol>p.protocolBytes)return fail(new SandboxError('OUTPUT_LIMIT'))
          line+=chunk
          for(;;){const i=line.indexOf('\n');if(i<0)break;const text=line.slice(0,i);line=line.slice(i+1)
            // IronCalc's existing importer prints this known diagnostic when
            // a saved formula has no cached value. It is not a protocol reply.
            // Count it against both total protocol and a separate noise budget;
            // never echo workbook-derived diagnostics into controller logs.
            if(/^Unexpected type \([^\r\n]{0,64}\) in [^\r\n]{1,512}$/.test(text)){
              stderr+=Buffer.byteLength(text);if(stderr>65536)return fail(new SandboxError('OUTPUT_LIMIT'));continue
            }
            try{const packet=JSON.parse(text),waiter=pending.get(packet.requestId);if(packet.version!==1||typeof packet.ok!=='boolean'||!waiter)return fail(new SandboxError('INVALID_PROTOCOL'));pending.delete(packet.requestId);packet.ok?waiter.resolve(packet.result):waiter.reject(new SandboxError('NATIVE_FAILED'))}catch{return fail(new SandboxError('INVALID_PROTOCOL'))}
          }
        })
        running.stderr!.on('data',(chunk:Buffer)=>{stderr+=chunk.length;if(stderr>65536)fail(new SandboxError('OUTPUT_LIMIT'))})
        running.on('error',()=>fail(new SandboxError('HOST_BACKEND_UNAVAILABLE')))
        const exited=new Promise<number|null>(resolve=>running.once('close',async code=>{
          resolve(code)
          if(!normal&&!reason){const status=await state().catch(()=>({} as Record<string,string>));const oom=status.Result==='oom-kill';fail(new SandboxError(oom||['24','25'].includes(status.ExecMainStatus)?'RESOURCE_LIMIT':status.Result==='timeout'?'SANDBOX_TIMEOUT':'NATIVE_FAILED',code??undefined,oom))}
        }))
        let info: Record<string,string>={}
        const startup=Date.now()+5000
        while(Date.now()<startup){check();info=await state().catch(()=>({}));if(Number(info.MainPID)>0&&info.ActiveState==='active')break;await new Promise(resolve=>setTimeout(resolve,20))}
        check();const pid=Number(info.MainPID)
        if(!pid||!info.InvocationID||!info.ControlGroup)throw new SandboxError('HOST_STARTUP_FAILED')
        const uid=Number(/^Uid:\s+(\d+)/m.exec(await readFile('/proc/'+pid+'/status','utf8'))?.[1])
        if(!uid||!(await readFile('/proc/'+pid+'/cgroup','utf8')).split('\n').includes('0::'+info.ControlGroup))throw new SandboxError('HOST_IDENTITY_MISMATCH')
        work=await open('/proc/'+pid+'/root/work',constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW)
        const fresh=await state()
        if(fresh.MainPID!==String(pid)||fresh.InvocationID!==info.InvocationID||fresh.ActiveState!=='active'||Number(/^Uid:\s+(\d+)/m.exec(await readFile('/proc/'+pid+'/status','utf8'))?.[1])!==uid)throw new SandboxError('HOST_IDENTITY_MISMATCH')
        await work.chown(uid,uid);await work.chmod(0o700)
        const dir='/proc/self/fd/'+work.fd
        const file=await open(dir+'/input.xlsx',constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o400)
        try{await file.chown(uid,uid);await file.writeFile(bytes);await file.sync()}finally{await file.close()}
        check()
        let partBytes=0,partCount=0
        const session:SandboxSession={
          async writePart(value){
            check()
            if(!(value instanceof Uint8Array)||value.length>MAX||partBytes+value.length>MAX||partCount>=256)throw new SandboxError('INPUT_LIMIT')
            const bytes=Buffer.from(value),name='part-'+randomUUID()
            partBytes+=bytes.length;partCount++
            const writing=(async()=>{
              const file=await open(dir+'/'+name,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o444)
              try{await file.writeFile(bytes);await file.sync();check();return '/work/'+name}finally{await file.close()}
            })()
            transfers.add(writing);try{return await writing}finally{transfers.delete(writing)}
          },
          request(command,args){try{check();if(!permitted.has(command))return Promise.reject(new SandboxError('UNSUPPORTED_COMMAND'));if(!args||typeof args!=='object'||Array.isArray(args)||['command','version','requestId'].some(k=>Object.hasOwn(args,k))||pending.size>=8)return Promise.reject(new SandboxError('INVALID_REQUEST'));const requestId='host-'+(++sequence),text=JSON.stringify({version:1,requestId,command,...args})+'\n';if(Buffer.byteLength(text)>65536)return Promise.reject(new SandboxError('INPUT_LIMIT'));return new Promise((resolve,reject)=>{pending.set(requestId,{resolve,reject});running.stdin!.write(text,error=>{if(error)fail(new SandboxError('NATIVE_FAILED'))})})}catch(error){return Promise.reject(error)}},
          async readOutput(){
            check()
            const reading=(async()=>{const output=await open(dir+'/output.xlsx',constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK).catch(()=>{throw new SandboxError('INVALID_OUTPUT')});try{const stat=await output.stat();if(!stat.isFile()||stat.size<1)throw new SandboxError('INVALID_OUTPUT');if(stat.size>p.outputBytes)throw new SandboxError('OUTPUT_LIMIT');const buffer=await bounded(output,stat.size);check();return buffer}finally{await output.close()}})()
            transfers.add(reading);try{return await reading}finally{transfers.delete(reading)}
          },
        }
        check();return {session,running,exited}
      })();void initializing.catch(()=>{})
      const operation=(async()=>{const {session,running,exited}=await initializing;check();const result=await execute(session);check();normal=true;running.stdin!.end();if(await exited!==0)throw new SandboxError('NATIVE_FAILED');check();return result})();void operation.catch(()=>{})
      try{return await Promise.race([operation,interrupted])}
      catch(error){if(reason||error instanceof SandboxError)throw reason??error;const failure=new SandboxError('HOST_BACKEND_UNAVAILABLE');failure.cause=error;throw failure}
      finally{
        clearTimeout(timer);signal?.removeEventListener('abort',abort);reason??=new SandboxError('CLOSED');for(const waiter of pending.values())waiter.reject(reason);pending.clear()
        try{
          await initializing.catch(()=>{});await Promise.allSettled([...transfers])
          await systemctl(['stop',unit]).catch(()=>{})
          // A failed stop cannot be reported as successful cleanup. Preserve the
          // public preparation root for the recovery sweep if state is unknown.
          const stopped=await state().catch(()=>undefined)
          await work?.close();child?.stdin?.destroy();child?.kill('SIGKILL')
          if(!stopped||stopped.MainPID!=='0'||!['inactive','failed'].includes(stopped.ActiveState))throw new SandboxError('HOST_CLEANUP_FAILED')
          await systemctl(['reset-failed',unit]).catch(()=>{});await rm(base,{recursive:true,force:true})
        }
        finally{active--;memory-=p.memoryMiB}
      }
    },
  }
}
