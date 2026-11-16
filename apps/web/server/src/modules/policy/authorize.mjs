import { withPrincipalTransaction } from '../../../db/context.mjs'
import { normalizePrincipal } from './principal.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ACTIONS = new Set([
  'file:read',
  'file:write',
  'file:delete',
  'object:read',
  'object:write',
  'revision:read',
  'revision:commit',
  'job:enqueue',
  'job:cancel',
])

const LOOKUP = `
  SELECT id::text AS id FROM dyoffice_files WHERE id = $1::uuid
  UNION ALL
  SELECT file_id::text AS id FROM dyoffice_revision_files WHERE file_id = $1::uuid
  LIMIT 1
`

function denied(status = 404) {
  if (status === 401) {
    return Object.assign(new Error('请登录'), { code: 'UNAUTHENTICATED', status: 401, publicCode: 'UNAUTHENTICATED' })
  }
  return Object.assign(new Error('文件不存在'), { code: 'NOT_FOUND', status: 404, publicCode: 'NOT_FOUND' })
}

function unavailable() {
  return Object.assign(new Error('服务暂时不可用'), { code: 'UNAVAILABLE', status: 503, publicCode: 'UNAVAILABLE' })
}

/**
 * T08 calls authorize(principal, 'job:enqueue' | 'job:cancel', { artifactId }).
 * The artifact must be visible to that principal under row-level security.
 * config_admin does not widen the query. A missing row and another owner's
 * row return the same not-found error.
 */
export function createAuthorizer(pool) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('PostgreSQL pool required')
  return async function authorize(principal, action, resource) {
    let actor
    try {
      actor = normalizePrincipal(principal)
    } catch (error) {
      if (error?.code === 'UNAUTHENTICATED') throw denied(401)
      throw unavailable()
    }
    if (!ACTIONS.has(action)) throw denied()
    if (!resource || typeof resource !== 'object' || Array.isArray(resource)) throw denied()
    if (resource.role !== undefined || resource.roles !== undefined) throw denied()
    const owner = resource.ownerId ?? resource.userId
    if (owner !== undefined && owner !== actor.userId) throw denied()
    if (resource.deploymentId !== undefined && resource.deploymentId !== actor.deploymentId) throw denied()
    const id = resource.artifactId || resource.fileId || resource.id
    if (typeof id !== 'string' || !UUID.test(id)) throw denied()
    try {
      await withPrincipalTransaction(pool, actor, async (client) => {
        const found = await client.query(LOOKUP, [id])
        if (found.rowCount !== 1) throw denied()
      })
    } catch (error) {
      if (error?.code === 'NOT_FOUND' || error?.code === 'UNAUTHENTICATED') throw error
      throw unavailable()
    }
  }
}
