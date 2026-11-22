/** Wake the channel scheduler from durable events. The snapshot remains the authority for claims. */
export function followChannelEvents(path: string, proof: string, cursor: () => number, changed: () => void, fetchImpl = fetch) {
  const controller = new AbortController()
  let retry: ReturnType<typeof setTimeout> | undefined
  let failures = 0
  async function listen() {
    let reconnect = true
    try {
      const response = await fetchImpl(path + '?after=' + cursor(), {
        headers: { accept: 'text/event-stream', 'x-csrf-token': proof },
        credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store', signal: controller.signal,
      })
      if (!response.ok || !response.body || !response.headers.get('content-type')?.startsWith('text/event-stream')) {
        reconnect = !response.ok && response.status >= 500
        if (!controller.signal.aborted && [401, 403, 404].includes(response.status)) changed()
        await response.body?.cancel()
        return
      }
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
      let buffer = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += value
        let end: number
        let updated = false
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, end)
          buffer = buffer.slice(end + 2)
          const sequence = Number(/^id: (\d+)$/m.exec(frame)?.[1])
          if (Number.isSafeInteger(sequence) && sequence > cursor()) updated = true
        }
        if (updated && !controller.signal.aborted) { failures = 0; changed() }
      }
    } catch { /* Existing workspace notifications continue during stream recovery. */ }
    finally {
      if (reconnect && !controller.signal.aborted) retry = setTimeout(listen, Math.min(8000, 500 * 2 ** Math.min(failures++, 4)))
    }
  }
  void listen()
  return () => { controller.abort(); clearTimeout(retry) }
}
