import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { constants } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { SandboxError, type SandboxLimits, type SandboxSession } from './contracts.ts'

const MAX = 32 * 1024 * 1024
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const WORK_PATH_PATTERN = /^\/work\/(input\.xlsx|output\.xlsx|part-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/
const commands = new Set([
  'open', 'close', 'save_archive', 'read_range', 'read_formula_cells', 'find_cells',
  'read_row_outline', 'read_media', 'recalc_cells', 'probe', 'network',
  'pids', 'sleep', 'busy', 'allocate', 'flood', 'output', 'symlink',
  'park', 'gateway_package', 'gateway_plan', 'gateway_convert_merge_source',
])

let active = 0
let memory = 0

async function bounded(file: FileHandle, size: number) {
  const buffer = Buffer.allocUnsafe(size + 1)
  let length = 0
  while (length < buffer.length) {
    const part = await file.read(buffer, length, buffer.length - length, null)
    if (part.bytesRead === 0) break
    length += part.bytesRead
  }
  if (length !== size) throw new SandboxError('OUTPUT_LIMIT')
  return buffer.subarray(0, length)
}

function rewriteNativeWorkPaths(value: unknown, workDir: string): unknown {
  if (typeof value === 'string') {
    const match = WORK_PATH_PATTERN.exec(value)
    return match ? join(workDir, match[1]!) : value
  }
  if (Array.isArray(value)) {
    return value.map(item => rewriteNativeWorkPaths(item, workDir))
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) {
      out[key] = rewriteNativeWorkPaths(entry, workDir)
    }
    return out
  }
  return value
}

/**
 * Cross-platform isolated subprocess backend for Windows, macOS, and non-root Linux.
 * Preserves the exact 2-slot concurrency budget, SHA-256 binary/script verification,
 * 32 MiB input/output caps, 256-part limit, 30s wall-clock kill timeout, and per-run
 * isolated temporary working directory without requiring root or systemd-run.
 */
export function createCrossPlatformProcess({
  binary,
  sha256,
  deploymentId,
  allowedCommands,
  limits = {},
  script,
}: {
  binary: string
  sha256: string
  deploymentId: string
  allowedCommands: readonly string[]
  limits?: SandboxLimits
  script?: { path: string; sha256: string }
}) {
  if (process.env.NODE_ENV === 'production') throw new SandboxError('HOST_BACKEND_UNAVAILABLE')
  if (!isAbsolute(binary) || !/^[a-f0-9]{64}$/.test(sha256) || !UUID.test(deploymentId)) {
    throw new SandboxError('UNTRUSTED_BINARY')
  }
  if (script && (!isAbsolute(script.path) || !/^[a-f0-9]{64}$/.test(script.sha256))) {
    throw new SandboxError('UNTRUSTED_BINARY')
  }
  const p = {
    memoryMiB: 512,
    pids: 64,
    cpuSeconds: 15,
    cpus: 1,
    wallMs: 30000,
    protocolBytes: 8 * 1024 * 1024,
    outputBytes: MAX,
    ...limits,
  }
  for (const [key, min, max] of [
    ['memoryMiB', 64, 1024],
    ['pids', 8, 128],
    ['cpuSeconds', 1, 120],
    ['wallMs', 500, 180000],
    ['protocolBytes', 1024, 16 * 1024 * 1024],
    ['outputBytes', 1, MAX],
  ] as const) {
    if (!Number.isInteger(p[key]) || p[key] < min || p[key] > max) {
      throw new SandboxError('INVALID_LIMIT')
    }
  }
  if (
    !Number.isFinite(p.cpus) ||
    p.cpus < 0.25 ||
    p.cpus > 2 ||
    !allowedCommands.length ||
    allowedCommands.some(c => !commands.has(c))
  ) {
    throw new SandboxError('INVALID_POLICY')
  }
  const permitted = new Set(allowedCommands)
  const openFlags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)

  return {
    deploymentId,
    async run<T>(
      input: Uint8Array,
      execute: (session: SandboxSession) => Promise<T>,
      { signal }: { signal?: AbortSignal } = {},
    ): Promise<T> {
      if (!(input instanceof Uint8Array) || input.length < 1 || input.length > MAX) {
        throw new SandboxError('INPUT_LIMIT')
      }
      if (signal?.aborted) throw new SandboxError('ABORTED')
      if (active >= 2 || memory + p.memoryMiB > 1024) throw new SandboxError('SANDBOX_BUSY')
      active++
      memory += p.memoryMiB

      const bytes = Buffer.from(input)
      const transfers = new Set<Promise<unknown>>()
      const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>()
      let base = ''
      let reason: SandboxError | undefined
      let child: ReturnType<typeof spawn> | undefined
      let exitPromise: Promise<number | null> | undefined
      let normal = false
      let line = ''
      let protocol = 0
      let stderr = 0
      let sequence = 0
      let interrupt!: (error: Error) => void
      const interrupted = new Promise<never>((_, reject) => {
        interrupt = reject
      })
      void interrupted.catch(() => {})

      const fail = (error: SandboxError) => {
        if (reason) return
        reason = error
        for (const waiter of pending.values()) waiter.reject(error)
        pending.clear()
        interrupt(error)
        try {
          child?.kill('SIGKILL')
        } catch {
          // Ignore kill errors after exit.
        }
      }
      const check = () => {
        if (reason) throw reason
        if (signal?.aborted) throw new SandboxError('ABORTED')
      }
      const abort = () => fail(new SandboxError('ABORTED'))
      signal?.addEventListener('abort', abort, { once: true })
      const timer = setTimeout(() => fail(new SandboxError('SANDBOX_TIMEOUT')), p.wallMs)

      const initializing = (async () => {
        const binaryLimit = script ? 160 * 1024 * 1024 : 64 * 1024 * 1024
        const native = await open(binary, openFlags)
        let source: Buffer
        try {
          const stat = await native.stat()
          if (!stat.isFile() || stat.size < 1 || stat.size > binaryLimit) {
            throw new SandboxError('UNTRUSTED_BINARY')
          }
          source = await bounded(native, stat.size)
        } finally {
          await native.close()
        }
        if (createHash('sha256').update(source).digest('hex') !== sha256) {
          throw new SandboxError('UNTRUSTED_BINARY')
        }

        base = await mkdtemp(join(tmpdir(), `dyoffice-${deploymentId}-`))
        const workDir = join(base, 'work')
        const binDir = join(base, 'bin')
        await mkdir(workDir, { recursive: true, mode: 0o700 })
        await mkdir(binDir, { recursive: true, mode: 0o700 })
        check()

        let spawnBinary = binary
        let spawnArgs: string[] = []
        if (script) {
          const file = await open(script.path, openFlags)
          let bundle: Buffer
          try {
            const stat = await file.stat()
            if (!stat.isFile() || stat.size < 1 || stat.size > MAX) {
              throw new SandboxError('UNTRUSTED_BINARY')
            }
            bundle = await bounded(file, stat.size)
          } finally {
            await file.close()
          }
          if (createHash('sha256').update(bundle).digest('hex') !== script.sha256) {
            throw new SandboxError('UNTRUSTED_BINARY')
          }
          const scriptSnapshot = join(binDir, 'gateway.mjs')
          await writeFile(scriptSnapshot, bundle, { mode: 0o444, flag: 'wx' })
          spawnArgs = [scriptSnapshot]
        } else {
          const exeExt = process.platform === 'win32' && binary.toLowerCase().endsWith('.exe') ? '.exe' : ''
          const nativeSnapshot = join(binDir, `native${exeExt}`)
          await writeFile(nativeSnapshot, source, { mode: 0o555, flag: 'wx' })
          spawnBinary = nativeSnapshot
        }

        await writeFile(join(workDir, 'input.xlsx'), bytes, { mode: 0o400, flag: 'wx' })
        check()

        const childEnv: NodeJS.ProcessEnv = {
          LANG: 'C.UTF-8',
          TMPDIR: workDir,
          TMP: workDir,
          TEMP: workDir,
          DYOFFICE_WORK_DIR: workDir,
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          ...(process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}),
        }

        child = spawn(spawnBinary, spawnArgs, {
          cwd: workDir,
          env: childEnv,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        })
        const running = child
        running.stdin!.on('error', () => {
          if (!normal) fail(new SandboxError('NATIVE_FAILED'))
        })
        running.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
          protocol += Buffer.byteLength(chunk)
          if (protocol > p.protocolBytes) return fail(new SandboxError('OUTPUT_LIMIT'))
          line += chunk
          for (;;) {
            const i = line.indexOf('\n')
            if (i < 0) break
            const text = line.slice(0, i).replace(/\r$/, '')
            line = line.slice(i + 1)
            if (/^Unexpected type \([^\r\n]{0,64}\) in [^\r\n]{1,512}$/.test(text)) {
              stderr += Buffer.byteLength(text)
              if (stderr > 65536) return fail(new SandboxError('OUTPUT_LIMIT'))
              continue
            }
            try {
              const packet = JSON.parse(text)
              const waiter = pending.get(packet.requestId)
              if (packet.version !== 1 || typeof packet.ok !== 'boolean' || !waiter) {
                return fail(new SandboxError('INVALID_PROTOCOL'))
              }
              pending.delete(packet.requestId)
              if (packet.ok) waiter.resolve(packet.result)
              else waiter.reject(new SandboxError('NATIVE_FAILED'))
            } catch {
              return fail(new SandboxError('INVALID_PROTOCOL'))
            }
          }
        })
        running.stderr!.on('data', (chunk: Buffer) => {
          stderr += chunk.length
          if (stderr > 65536) fail(new SandboxError('OUTPUT_LIMIT'))
        })
        running.on('error', () => fail(new SandboxError('HOST_BACKEND_UNAVAILABLE')))
        exitPromise = new Promise<number | null>(resolve =>
          running.once('close', code => {
            resolve(code)
            if (!normal && !reason) {
              fail(new SandboxError('NATIVE_FAILED', code ?? undefined, false))
            }
          }),
        )

        let partBytes = 0
        let partCount = 0
        const session: SandboxSession = {
          async writePart(value) {
            check()
            if (
              !(value instanceof Uint8Array) ||
              value.length > MAX ||
              partBytes + value.length > MAX ||
              partCount >= 256
            ) {
              throw new SandboxError('INPUT_LIMIT')
            }
            const partBuf = Buffer.from(value)
            const name = 'part-' + randomUUID()
            partBytes += partBuf.length
            partCount++
            const writing = (async () => {
              await writeFile(join(workDir, name), partBuf, { mode: 0o444, flag: 'wx' })
              check()
              return '/work/' + name
            })()
            transfers.add(writing)
            try {
              return await writing
            } finally {
              transfers.delete(writing)
            }
          },
          request(command, args) {
            try {
              check()
              if (!permitted.has(command)) {
                return Promise.reject(new SandboxError('UNSUPPORTED_COMMAND'))
              }
              if (
                !args ||
                typeof args !== 'object' ||
                Array.isArray(args) ||
                ['command', 'version', 'requestId'].some(k => Object.hasOwn(args, k)) ||
                pending.size >= 8
              ) {
                return Promise.reject(new SandboxError('INVALID_REQUEST'))
              }
              const effectiveArgs = script
                ? args
                : (rewriteNativeWorkPaths(args, workDir) as Record<string, unknown>)
              const requestId = 'host-' + ++sequence
              const text = JSON.stringify({ version: 1, requestId, command, ...effectiveArgs }) + '\n'
              if (Buffer.byteLength(text) > 65536) {
                return Promise.reject(new SandboxError('INPUT_LIMIT'))
              }
              return new Promise((resolve, reject) => {
                pending.set(requestId, { resolve, reject })
                running.stdin!.write(text, error => {
                  if (error) fail(new SandboxError('NATIVE_FAILED'))
                })
              })
            } catch (error) {
              return Promise.reject(error)
            }
          },
          async readOutput() {
            check()
            const reading = (async () => {
              const output = await open(join(workDir, 'output.xlsx'), openFlags).catch(() => {
                throw new SandboxError('INVALID_OUTPUT')
              })
              try {
                const stat = await output.stat()
                if (!stat.isFile() || stat.size < 1) throw new SandboxError('INVALID_OUTPUT')
                if (stat.size > p.outputBytes) throw new SandboxError('OUTPUT_LIMIT')
                const buffer = await bounded(output, stat.size)
                check()
                return buffer
              } finally {
                await output.close()
              }
            })()
            transfers.add(reading)
            try {
              return await reading
            } finally {
              transfers.delete(reading)
            }
          },
        }
        check()
        return { session, running, exited: exitPromise }
      })()
      void initializing.catch(() => {})

      const operation = (async () => {
        const { session, running, exited } = await initializing
        check()
        const result = await execute(session)
        check()
        normal = true
        running.stdin!.end()
        if ((await exited) !== 0) throw new SandboxError('NATIVE_FAILED')
        check()
        return result
      })()
      void operation.catch(() => {})

      try {
        return await Promise.race([operation, interrupted])
      } catch (error) {
        if (reason || error instanceof SandboxError) throw reason ?? error
        const failure = new SandboxError('HOST_BACKEND_UNAVAILABLE')
        failure.cause = error
        throw failure
      } finally {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        reason ??= new SandboxError('CLOSED')
        for (const waiter of pending.values()) waiter.reject(reason)
        pending.clear()
        try {
          await initializing.catch(() => {})
          await Promise.allSettled([...transfers])
          child?.stdin?.destroy()
          try {
            child?.kill('SIGKILL')
          } catch {
            // Ignore kill errors.
          }
          await exitPromise?.catch(() => {})
          if (base) await rm(base, { recursive: true, force: true }).catch(() => {})
        } finally {
          active--
          memory -= p.memoryMiB
        }
      }
    },
  }
}
