import { spawn,execFile, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { mkdtemp,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const exec = promisify(execFile)
const MAX_FILE = 32 * 1024 * 1024
const nativeCommands = new Set(['open','read_range','recalc_cells','save_archive','close'])
const probeCommands = new Set(['probe','network','pids','sleep','busy','allocate','flood','output','symlink'])
let active = 0, activeMemory = 0
export class SandboxError extends Error {
  readonly code: string
  readonly exitCode?: number
  readonly oomKilled?: boolean
  constructor(code: string,exitCode?: number,oomKilled?: boolean) { super(code); this.name = 'SandboxError'; this.code=code; this.exitCode=exitCode; this.oomKilled=oomKilled }
}
export interface SandboxLimits { memoryMiB?: number; pids?: number; cpuSeconds?: number; cpus?: number; wallMs?: number; protocolBytes?: number; outputBytes?: number }
export interface SandboxSession { request(command: string,args: Record<string,unknown>): Promise<unknown>; readOutput(): Promise<Buffer> }
export function createSandboxProcess({ image,allowedCommands,limits = {} }: { image: string; allowedCommands: readonly string[]; limits?: SandboxLimits }) {
  if (process.env.NODE_ENV === 'production') throw new Error('Docker development sandbox requires release gates')
  if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new SandboxError('UNTRUSTED_IMAGE')
  const policy = { memoryMiB: 512,pids: 64,cpuSeconds: 15,cpus: 1,wallMs: 30_000,protocolBytes: 8*1024*1024,outputBytes: MAX_FILE,...limits }
  for (const [name,min,max] of [['memoryMiB',64,1024],['pids',8,128],['cpuSeconds',1,120],['wallMs',500,180_000],['protocolBytes',1024,16*1024*1024],['outputBytes',1,MAX_FILE]] as const) if (!Number.isInteger(policy[name]) || policy[name]<min || policy[name]>max) throw new SandboxError('INVALID_LIMIT')
  if (!Number.isFinite(policy.cpus) || policy.cpus<0.25 || policy.cpus>2 || !allowedCommands.length || allowedCommands.some(command => !nativeCommands.has(command) && !probeCommands.has(command))) throw new SandboxError('INVALID_POLICY')
  const permitted = new Set(allowedCommands)
  return {
    async run<T>(input: Uint8Array,execute: (session: SandboxSession) => Promise<T>,{ signal }: { signal?: AbortSignal } = {}): Promise<T> {
      if (!(input instanceof Uint8Array) || input.byteLength<1 || input.byteLength>MAX_FILE) throw new SandboxError('INPUT_LIMIT')
      if (signal?.aborted) throw new SandboxError('ABORTED')
      if (active>=2 || activeMemory+policy.memoryMiB>1024) throw new SandboxError('SANDBOX_BUSY')
      active++; activeMemory += policy.memoryMiB
      const bytes = Buffer.from(input), name = 'dyoffice-job-' + randomUUID(), pending = new Map<string,{ resolve(value: unknown): void; reject(error: Error): void }>()
      const transfers = new Set<ReturnType<typeof spawn>>()
      let directory: string | undefined, attached: ChildProcessWithoutNullStreams | undefined, created: Promise<unknown> | undefined, preparing: Promise<string> | undefined
      let reason: SandboxError | undefined, normalClose = false, requestId = 0, outputBytes = 0, line = '', stderrBytes = 0, supervisorLog = ''
      let interrupt!: (error: Error) => void
      const interrupted = new Promise<never>((_,reject) => { interrupt = reject })
      // Install a handler before any asynchronous startup can fail.
      void interrupted.catch(() => {})
      const dockerEnv = () => ({ PATH: '/usr/bin:/bin',LANG: 'C.UTF-8',DOCKER_CONFIG: join(directory ?? tmpdir(),'docker-config') })
      const args = (tail: string[]) => ['--host','unix:///var/run/docker.sock',...tail]
      const command = (tail: string[],timeout = 10_000) => exec('/usr/bin/docker',args(tail),{ env: dockerEnv(),timeout,maxBuffer: 256*1024,windowsHide: true })
      const fail = (error: SandboxError) => {
        if (reason) return
        reason = error; for (const waiter of pending.values()) waiter.reject(error); pending.clear(); interrupt(error)
        void command(['kill','--signal','KILL',name],3000).catch(() => {})
      }
      const check = () => { if (reason) throw reason; if (signal?.aborted) throw new SandboxError('ABORTED') }
      const abort = () => fail(new SandboxError('ABORTED'))
      signal?.addEventListener('abort',abort,{ once: true })
      const timer = setTimeout(() => fail(new SandboxError('SANDBOX_TIMEOUT')),policy.wallMs)
      const operation = (async () => {
        preparing = mkdtemp(join(tmpdir(),'dyoffice-sandbox-')); directory = await preparing; check()
        if ((await command(['info','--format','{{.CgroupVersion}}'])).stdout.trim()!=='2') throw new SandboxError('SANDBOX_UNAVAILABLE')
        const security = JSON.parse((await command(['info','--format','{{json .SecurityOptions}}'])).stdout)
        if (!security.some((value: string) => value.startsWith('name=seccomp,'))) throw new SandboxError('SANDBOX_UNAVAILABLE')
        const [metadata] = JSON.parse((await command(['image','inspect',image])).stdout)
        const entry = metadata.Config.Entrypoint
        const commands = metadata.Config.Cmd?.[0] === 'xlsx' ? nativeCommands : metadata.Config.Cmd?.[0] === 'probe' ? probeCommands : null
        if (!commands || entry?.length!==1 || entry[0]!=='/usr/local/bin/supervisor' || metadata.Config.Cmd?.length!==1 || Object.keys(metadata.Config.Volumes ?? {}).length || [...permitted].some(value => !commands.has(value))) throw new SandboxError('UNTRUSTED_IMAGE')
        check()
        created = command(['create','-i','--init','--pull=never','--name',name,'--label','dyoffice.sandbox=true','--user','10001:10001','--workdir','/work','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--memory',policy.memoryMiB+'m','--memory-swap',policy.memoryMiB+'m','--cpus',String(policy.cpus),'--pids-limit',String(policy.pids),'--ulimit','core=0:0','--ulimit','nofile=64:64','--ulimit',`cpu=${policy.cpuSeconds}:${policy.cpuSeconds+1}`,'--ulimit',`fsize=${MAX_FILE}:${MAX_FILE}`,'--tmpfs','/work:rw,noexec,nosuid,size=128m,uid=10001,gid=10001,mode=0700','--env','LANG=C.UTF-8','--env','TMPDIR=/work',image])
        await created; check()
        const [container] = JSON.parse((await command(['inspect',name])).stdout), host = container.HostConfig
        if (container.Config.User!=='10001:10001' || host.NetworkMode!=='none' || host.Init!==true || !host.ReadonlyRootfs || host.Privileged || host.PidMode==='host' || host.IpcMode==='host' || !host.CapDrop?.includes('ALL') || !host.SecurityOpt?.includes('no-new-privileges') || host.Memory!==policy.memoryMiB*1024*1024 || host.MemorySwap!==host.Memory || host.PidsLimit!==policy.pids || (host.Binds?.length ?? 0) || (host.Mounts?.length ?? 0)) throw new SandboxError('INVALID_CONTAINER_POLICY')
        check()
        attached = spawn('/usr/bin/docker',args(['start','-a','-i',name]),{ env: dockerEnv(),stdio: ['pipe','pipe','pipe'],windowsHide: true })
        const child = attached
        child.stdin.on('error',() => { if (!normalClose) fail(new SandboxError('NATIVE_FAILED')) })
        child.stdout.setEncoding('utf8').on('data',(chunk: string) => {
          if (reason) return
          outputBytes += Buffer.byteLength(chunk)
          if (outputBytes>policy.protocolBytes) return fail(new SandboxError('OUTPUT_LIMIT'))
          line += chunk
          for (;;) {
            const newline = line.indexOf('\n'); if (newline<0) break
            const text = line.slice(0,newline); line = line.slice(newline+1)
            try {
              const response = JSON.parse(text), waiter = pending.get(response.requestId)
              if (response.version!==1 || typeof response.ok!=='boolean' || !waiter) return fail(new SandboxError('INVALID_PROTOCOL'))
              pending.delete(response.requestId)
              if (response.ok) waiter.resolve(response.result)
              else waiter.reject(new SandboxError('NATIVE_FAILED'))
            } catch { return fail(new SandboxError('INVALID_PROTOCOL')) }
          }
        })
        child.stderr.on('data',chunk => { stderrBytes += chunk.length; supervisorLog += chunk.toString('utf8'); if (stderrBytes>1024) fail(new SandboxError('OUTPUT_LIMIT')) })
        child.on('error',() => fail(new SandboxError('NATIVE_FAILED')))
        const exited = new Promise<number | null>(resolve => child.once('close',async code => {
          resolve(code)
          if (!normalClose && !reason) {
            let state: { Running: boolean; OOMKilled: boolean; ExitCode: number } | undefined
            for (let attempt=0;attempt<6;attempt++) {
              try { state = JSON.parse((await command(['inspect','--format','{{json .State}}',name],3000)).stdout) } catch {}
              if (state && !state.Running && (code!==137 || state.OOMKilled || attempt===5)) break
              await new Promise(resolve => setTimeout(resolve,20))
            }
            let report: { oomKilled?: boolean; stderrLimited?: boolean; exitCode?: number } | undefined
            const match = /^DYOFFICE_SANDBOX_STATUS=(\{[^\n]+\})\n$/.exec(supervisorLog)
            if (match) { try { report = JSON.parse(match[1]) } catch {} }
            const oom = state?.OOMKilled === true || report?.oomKilled === true
            const failure = new SandboxError(report?.stderrLimited ? 'OUTPUT_LIMIT' : oom || [152,153].includes(code ?? 0) ? 'RESOURCE_LIMIT' : 'NATIVE_FAILED',code ?? undefined,oom)
            failure.cause = { state,exitCode: code }; fail(failure)
          }
        }))
        const startup = Date.now()+5000
        while (!(JSON.parse((await command(['inspect','--format','{{json .State.Running}}',name])).stdout))) {
          check(); if (Date.now()>startup) throw new SandboxError('NATIVE_STARTUP_FAILED')
          await new Promise(resolve => setTimeout(resolve,20))
        }
        check()
        // Docker archive PUT refuses read-only roots even for a writable tmpfs.
        // A fixed, audited file descriptor helper writes into this private tmpfs;
        // no host path or controller environment enters the container.
        await new Promise<void>((resolve,reject) => {
          const sender = spawn('/usr/bin/docker',args(['exec','-i','--user','10001:10001',name,'/usr/local/bin/artifact-io','put']),{ env: dockerEnv(),stdio: ['pipe','pipe','pipe'] })
          transfers.add(sender); sender.stdout.resume(); sender.stderr.resume()
          sender.on('error',() => reject(new SandboxError('INPUT_TRANSFER_FAILED')))
          sender.stdin.on('error',() => reject(new SandboxError('INPUT_TRANSFER_FAILED')))
          sender.once('close',code => { transfers.delete(sender); code===0 ? resolve() : reject(new SandboxError('INPUT_TRANSFER_FAILED')) })
          sender.stdin.end(bytes)
        })
        check()
        const session: SandboxSession = {
          request(commandName,values) {
            try {
              check()
              if (!permitted.has(commandName)) return Promise.reject(new SandboxError('UNSUPPORTED_COMMAND'))
              if (!values || typeof values!=='object' || Array.isArray(values) || ['command','version','requestId'].some(key => Object.hasOwn(values,key)) || pending.size>=8) return Promise.reject(new SandboxError('INVALID_REQUEST'))
              const id = 'sandbox-' + (++requestId), packet = JSON.stringify({ version: 1,requestId: id,command: commandName,...values }) + '\n'
              if (Buffer.byteLength(packet)>65536) return Promise.reject(new SandboxError('INPUT_LIMIT'))
              return new Promise((resolve,reject) => { pending.set(id,{ resolve,reject }); child.stdin.write(packet,error => { if (error) fail(new SandboxError('NATIVE_FAILED')) }) })
            } catch (error) { return Promise.reject(error) }
          },
          async readOutput() {
            check()
            const copy = spawn('/usr/bin/docker',args(['exec','--user','10001:10001',name,'/usr/local/bin/artifact-io','get']),{ env: dockerEnv(),stdio: ['ignore','pipe','pipe'] })
            transfers.add(copy)
            const chunks: Buffer[] = []; let size=0
            const result = new Promise<Buffer>((resolve,reject) => {
              copy.stdout.on('data',(chunk: Buffer) => {
                size += chunk.length
                if (size>policy.outputBytes) { copy.kill('SIGKILL'); reject(new SandboxError('OUTPUT_LIMIT')); return }
                chunks.push(chunk)
              })
              copy.stderr.resume(); copy.on('error',() => reject(new SandboxError('INVALID_OUTPUT')))
              copy.on('close',code => { transfers.delete(copy); code===0 && size>0 ? resolve(Buffer.concat(chunks,size)) : reject(new SandboxError('INVALID_OUTPUT')) })
            })
            try { return await Promise.race([result,interrupted]) } finally { copy.kill('SIGKILL') }
          },
        }
        const result = await execute(session); check(); normalClose = true; child.stdin.end()
        if (await exited !== 0) throw new SandboxError('NATIVE_FAILED')
        check(); return result
      })()
      void operation.catch(() => {})
      try { return await Promise.race([operation,interrupted]) }
      catch (error) {
        if (reason || error instanceof SandboxError) throw reason ?? error
        const failure = new SandboxError('SANDBOX_UNAVAILABLE'); failure.cause = error; throw failure
      }
      finally {
        clearTimeout(timer); signal?.removeEventListener('abort',abort)
        if (!reason) reason = new SandboxError('CLOSED')
        for (const waiter of pending.values()) waiter.reject(reason); pending.clear()
        try {
          if (preparing) directory = await preparing.catch(() => undefined)
          await created?.catch(() => {})
          await command(['rm','-f',name],5000)
        } catch (error) {
          if (!String((error as { stderr?: string }).stderr ?? '').includes('No such container')) throw new SandboxError('CLEANUP_FAILED')
        } finally {
          for (const transfer of transfers) transfer.kill('SIGKILL')
          attached?.stdin.destroy(); attached?.kill('SIGKILL')
          if (directory) await rm(directory,{ recursive: true,force: true })
          active--; activeMemory -= policy.memoryMiB
        }
      }
    },
  }
}
