// QA only. Runs after the real commit handler has produced HTTP 200.
export function createCommitFaultHook(getMode) {
  let lost = false
  return async (request, reply, payload) => {
    if (request.method !== 'POST' || !request.url.endsWith('/commits') || reply.statusCode !== 200)
      return payload
    const mode = getMode()
    if ((mode === 'lost' || mode === 'socket') && !lost) {
      lost = true
      if (mode === 'socket') {
        reply.raw.destroy()
        return payload
      }
      reply.code(503).header('Content-Type', 'application/json').removeHeader('Content-Length')
      return JSON.stringify({ error: 'QA_COMMIT_RESPONSE_UNCONFIRMED' })
    }
    if (mode === 'stall') await new Promise((resolve) => setTimeout(resolve, 10000))
    return payload
  }
}
