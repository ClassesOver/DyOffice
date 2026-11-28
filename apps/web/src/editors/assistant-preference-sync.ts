/** Share an invalidation only. Each window rereads through its own bound session. */
export function createAssistantPreferenceSync<T>(
  account: readonly [deploymentId: string, userId: string],
  read: () => Promise<T>,
  apply: (preferences: T) => void,
) {
  if (typeof BroadcastChannel !== 'function') return
  let channel: BroadcastChannel
  try { channel = new BroadcastChannel('dyoffice:assistant-preferences:' + JSON.stringify(account)) } catch { return }
  let closed = false
  let reading = false
  let retry = false
  let savedVersion = 0

  async function refresh() {
    if (closed) return
    retry = true
    if (reading) return
    reading = true
    try {
      while (retry && !closed) {
        retry = false
        const version = savedVersion
        try {
          const current = await read()
          if (closed) return
          if (version !== savedVersion) retry = true
          if (!retry) apply(current)
        } catch { /* Keep the last verified preferences if this window lost its session. */ }
      }
    } finally {
      reading = false
    }
  }

  channel.onmessage = ({data}) => {
    if (data === 'refresh') void refresh()
  }
  return {
    refresh,
    saved() {
      if (closed) return
      savedVersion++
      try { channel.postMessage('refresh') } catch { /* The account save has already succeeded. */ }
    },
    close() {
      closed = true
      channel.close()
    },
  }
}
