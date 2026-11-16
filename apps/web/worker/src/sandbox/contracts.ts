export class SandboxError extends Error {
  readonly code: string
  readonly exitCode?: number
  readonly oomKilled?: boolean
  constructor(code: string,exitCode?: number,oomKilled?: boolean) { super(code); this.name = 'SandboxError'; this.code=code; this.exitCode=exitCode; this.oomKilled=oomKilled }
}
export interface SandboxLimits { memoryMiB?: number; pids?: number; cpuSeconds?: number; cpus?: number; wallMs?: number; protocolBytes?: number; outputBytes?: number }
export interface SandboxSession { request(command: string,args: Record<string,unknown>): Promise<unknown>; readOutput(): Promise<Buffer> }
