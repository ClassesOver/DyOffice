import {createPreferencesClient, type SettingsRequest} from '../../../../packages/browser-host/src/preferences'
import type {createLocalShellClient} from './local-client'

type LocalClient = ReturnType<typeof createLocalShellClient>
type BoundSession = Awaited<ReturnType<LocalClient['bindSession']>>
const stale = () => Object.assign(new Error('登录状态已改变，请重新加载当前工作区。'), {code: 'stale_session'})

/** One preference write fence per workspace, including verified same-user cookie rotation. */
export function createLocalPreferencesSession(client: LocalClient) {
  let binding: BoundSession | undefined
  let version = 0
  client.onSessionEnded(() => { binding = undefined; version++ })
  const request: SettingsRequest = async <T>(path: string, method = 'GET', body?: unknown): Promise<T> => {
    const current = binding, stamp = version
    if (!current) throw stale()
    const obsolete = () => stamp !== version || current !== binding
    // A dispatched write may have committed before rotation. Do not turn that into a
    // known rejection: the shared preferences client must retain its unknown fence.
    const superseded = () => method === 'GET' || method === 'HEAD' ? stale() : new Error('会话已更新，上次偏好保存结果尚未确认，请重新读取后再修改。')
    try {
      const result = await current.request<T>(path, method, body)
      if (obsolete()) throw superseded()
      return result
    } catch (error) {
      if (obsolete()) throw superseded()
      const failure = error as {status?: number; code?: string}
      if (failure.code === 'stale_session') client.endSession('expired')
      else if (failure.status === 403) {
        // 403 is also an ordinary permission rejection. Only a confirmed cookie
        // mismatch/expiry opens recovery; never retry the preference mutation.
        try { await client.bindSession(current.proof) }
        catch (cause) {
          if (!obsolete() && (cause as {code?: string}).code === 'stale_session') client.endSession('expired')
        }
      }
      throw error
    }
  }
  return {
    preferences: createPreferencesClient(request),
    // Call only after the workspace identity has been verified. Keep the client
    // itself, and hence pending/unknown writes, across same-user password rotation.
    bind(session: BoundSession) { binding = session; version++ },
  }
}
