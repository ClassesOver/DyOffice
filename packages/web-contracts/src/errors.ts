export type HostErrorCode = 'UNSUPPORTED' | 'READ_ONLY' | 'INVALID_REVISION' | 'INVALID_RESPONSE' | 'PAYLOAD_TOO_LARGE' | 'UNAUTHORIZED' | 'CONFLICT' | 'UNAVAILABLE'

export class HostError extends Error {
  readonly code: HostErrorCode
  constructor(code: HostErrorCode, message: string) {
    super(message)
    this.name = 'HostError'
    this.code = code
  }
}

export function hostError(code: HostErrorCode, operation: string): HostError {
  return new HostError(code, `Web host operation ${operation} failed: ${code}`)
}

/** Public HTTP error DTO; server internals and unknown extensions are excluded. */
export interface Problem {
  readonly type: string
  readonly title: string
  readonly status: number
  readonly detail: string
  readonly requestId: string
  readonly error?: string
  readonly code?: string
}

/** Shape validation and projection, not redaction of server-authored prose. */
export function decodeProblem(value: unknown): Problem {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw hostError('INVALID_RESPONSE', 'problem')
  const v = value as Record<string, unknown>
  if (!['type', 'title', 'requestId'].every(k => typeof v[k] === 'string' && v[k].length > 0) ||
      typeof v.detail !== 'string' || typeof v.status !== 'number' || !Number.isInteger(v.status) ||
      v.status < 400 || v.status > 599 ||
      (v.error !== undefined && typeof v.error !== 'string') ||
      (v.code !== undefined && (typeof v.code !== 'string' || !v.code.length))) {
    throw hostError('INVALID_RESPONSE', 'problem')
  }
  return {
    type: v.type as string, title: v.title as string, status: v.status,
    detail: v.detail, requestId: v.requestId as string,
    ...(v.error === undefined ? {} : { error: v.error as string }),
    ...(v.code === undefined ? {} : { code: v.code as string }),
  }
}
