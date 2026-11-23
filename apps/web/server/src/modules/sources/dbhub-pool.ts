import { sourceError } from './config.ts'

export type DbhubSession = { close(): Promise<void> }
type Slot<T> = { ready: Promise<T>; active: number; idle?: NodeJS.Timeout; closing?: Promise<void> }

/** 冷启动也占一个槽位；并发请求共享初始化。只缓存连接，从不缓存查询结果。 */
export class DbhubPool<T extends DbhubSession> {
  private slots = new Map<string, Slot<T>>()
  private stopped = false
  constructor(private capacity = 8, private idleMs = 60_000) {}
  private retire(key: string, slot: Slot<T>) {
    clearTimeout(slot.idle)
    slot.closing ??= slot.ready.then(client => client.close(), () => {}).finally(() => {
      if (this.slots.get(key) === slot) this.slots.delete(key)
    })
    return slot.closing
  }
  async use<R>(key: string, start: () => Promise<T>, run: (client: T) => Promise<R>): Promise<R> {
    if (this.stopped) throw sourceError(503)
    let slot = this.slots.get(key)
    if (slot?.closing) {
      await slot.closing
      return this.use(key, start, run)
    }
    if (!slot) {
      if (this.slots.size >= this.capacity) {
        const idle = [...this.slots].find(([, other]) => !other.active)
        if (!idle) throw sourceError(429)
        await this.retire(...idle)
        return this.use(key, start, run)
      }
      slot = { active: 0, ready: start() }
      this.slots.set(key, slot)
    }
    clearTimeout(slot.idle)
    slot.active++
    let connected = false
    try { const session = await slot.ready; connected = true; return await run(session) }
    catch (error) {
      // 单条 SQL 错误不影响连接；传输故障或超时淘汰该会话，不重放请求。
      if (!connected || !(error as {statusCode?:number})?.statusCode || (error as {statusCode?:number}).statusCode === 504)
        await this.retire(key, slot)
      throw error
    } finally {
      if (!--slot.active && !slot.closing) slot.idle = setTimeout(() => { void this.retire(key, slot!) }, this.idleMs).unref()
    }
  }
  async close() {
    this.stopped = true
    await Promise.all([...this.slots].map(([key, slot]) => this.retire(key, slot)))
  }
}
