export const formats = new Set(['docx', 'xlsx', 'pptx', 'pdf'])
export const rawBody = Symbol('dyofficeRawBody')

export function fail(message, status = 400, publicCode) {
  const error = new Error(message)
  error.status = status
  if (publicCode !== undefined) error.publicCode = publicCode
  throw error
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function fields(value, allowed) {
  if (!isObject(value) || Object.keys(value).some((key) => !allowed.includes(key))) fail('配置包含不支持的字段')
}

export function httpUrl(value) {
  let url
  try { url = new URL(value) }
  catch { fail('请输入有效的 HTTP 地址') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) fail('仅支持无内嵌凭据的 HTTP/HTTPS 地址')
  return url.toString()
}

export async function readBytes(request, limit = 1024 * 1024) {
  const captured = request[rawBody]
  if (Buffer.isBuffer(captured)) {
    if (captured.length > limit) fail('请求内容过大', 413)
    return captured
  }
  let size = 0
  const chunks = []
  for await (const chunk of request) {
    size += chunk.length
    if (size > limit) fail('请求内容过大', 413)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

export async function readJson(request) {
  try { return JSON.parse((await readBytes(request)).toString()) }
  catch (error) {
    if (error.status) throw error
    fail('JSON 格式无效')
  }
}

export function publicModel({ id, model, enabled }) {
  return { id, model, enabled }
}
