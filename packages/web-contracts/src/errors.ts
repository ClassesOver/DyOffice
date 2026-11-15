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
