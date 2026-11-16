import { access, constants } from 'node:fs/promises'
import { sendJson } from './http-response.mjs'

/** Non-sensitive load-balancer probes for the legacy development server. */
export async function serveHealth(request, response, { path, dataDirectory, store }) {
  if (path !== '/api/v1/health/live' && path !== '/api/v1/health/ready') return false
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.setHeader('Allow', 'GET, HEAD')
    sendJson(response, 405, { error: 'Method not allowed' })
    return true
  }
  const live = path.endsWith('/live')
  const ready = live || await isStoreReady(dataDirectory, store)
  const status = ready ? 200 : 503
  // Neither probe includes sensitive config, file names, tokens, or filesystem paths.
  if (request.method === 'HEAD') {
    response.writeHead(status, { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
    response.end()
  } else sendJson(response, status, { state: ready ? (live ? 'alive' : 'ready') : 'unavailable' })
  return true
}

export async function isStoreReady(dataDirectory, store) {
  try {
    await access(dataDirectory, constants.R_OK | constants.W_OK)
    const snapshot = store.read()
    return Boolean(snapshot && Array.isArray(snapshot.files) && snapshot.preferences)
  } catch {
    return false
  }
}
