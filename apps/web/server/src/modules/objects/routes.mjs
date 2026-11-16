import { join } from 'node:path'
import { fail } from '../../http-helpers.mjs'

/** Dev-token stand-in. The caller cannot choose another owner. */
export const DEV_PERSONAL_OWNER = 'dev-personal'

export function objectStoreDirectory(dataDirectory) {
  return join(dataDirectory, 'object-store')
}

const OBJECT_PATH = /^\/api\/v1\/objects\/([0-9a-f-]{36})$/i

function disposition(name) {
  const safe = typeof name === 'string' && name.length > 0 && name.length <= 255 ? name : 'object.bin'
  return `attachment; filename*=UTF-8''${encodeURIComponent(safe)}`
}

/**
 * Download one finished object for the personal dev principal.
 * The owner id comes from the server, never from the request.
 */
export async function handleObjects(req, res, ctx, { path }) {
  const match = OBJECT_PATH.exec(path)
  if (!match) return false
  if (req.method !== 'GET') fail('方法不允许', 405)
  let opened
  try {
    opened = await ctx.objectStore.downloadObject({ ownerId: ctx.objectOwnerId, objectId: match[1] })
  } catch (error) {
    if (error?.code === 'NOT_FOUND') fail('文件不存在', 404)
    fail('服务暂时不可用', 500)
  }
  res.statusCode = 200
  res.setHeader('Content-Type', 'application/octet-stream')
  res.setHeader('Content-Length', String(opened.size))
  res.setHeader('Content-Disposition', disposition(opened.name))
  res.setHeader('X-Content-SHA256', opened.sha256)
  res.end(opened.bytes)
  return true
}
