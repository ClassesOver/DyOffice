import { STATUS_CODES } from 'node:http'

const DETAIL = {
  400: '请求无效',
  404: '接口不存在',
  405: 'Method not allowed',
  413: '请求内容过大',
  429: '请求过于频繁',
  500: '服务器内部错误',
  501: '接口尚未迁移到模块化 API',
  503: '服务暂不可用',
}

const CLIENT = new Set([400, 404, 405, 413, 429, 501, 503])

/** Fixed Problem envelope. Callers must not pass request data into the detail. */
export function problem(status, requestId) {
  const detail = DETAIL[status] ?? '请求无法完成'
  return {
    type: 'about:blank',
    title: STATUS_CODES[status] || 'Error',
    status,
    detail,
    error: detail,
    requestId,
  }
}

export function publicStatus(error) {
  const status = error?.statusCode
  if (CLIENT.has(status)) return status
  return 500
}
