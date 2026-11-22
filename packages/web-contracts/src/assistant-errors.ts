/**
 * Public error codes for assistant-facing data operations. A failure carries a
 * status and, when the server can classify it, one of these codes; never the
 * underlying message (which may name tables, hosts or credentials). The kind
 * tells a caller what to do next:
 *  - fix_request: rewrite the request (SQL, arguments) and try once more
 *  - retry_later: transient; the same request may succeed later
 *  - permission:  not allowed for this user or connection; do not retry
 *  - user_action: the user must change something (quota, configuration)
 */
export type AssistantErrorKind = 'fix_request' | 'retry_later' | 'permission' | 'user_action'

export const ASSISTANT_ERROR_CODES = Object.freeze({
  SQL_POLICY_REJECTED: 'fix_request',
  SQL_DATABASE_ERROR: 'fix_request',
  SOURCE_TIMEOUT: 'fix_request',
  SOURCE_RESULT_UNUSABLE: 'fix_request',
  SOURCE_SCOPE_DENIED: 'permission',
  SOURCE_READONLY_REQUIRED: 'user_action',
  SOURCE_TARGET_NOT_APPROVED: 'user_action',
  SOURCE_TLS_UNSUPPORTED: 'user_action',
  SOURCE_UNAVAILABLE: 'retry_later',
  RESULT_QUOTA_EXCEEDED: 'user_action',
} as const satisfies Record<string, AssistantErrorKind>)

export type AssistantErrorCode = keyof typeof ASSISTANT_ERROR_CODES

export function isAssistantErrorCode(value: unknown): value is AssistantErrorCode {
  return typeof value === 'string' && Object.hasOwn(ASSISTANT_ERROR_CODES, value)
}

/** Tag an error with a public code without changing its status or message. */
export function withAssistantErrorCode<E extends object>(error: E, code: AssistantErrorCode): E & { code: AssistantErrorCode } {
  return Object.assign(error, { code })
}
