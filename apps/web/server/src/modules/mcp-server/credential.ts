/** Transport parsing only. This is NOT authentication and must never mint a principal.
 * The caller must resolve the token against live storage and enforce audience,
 * expiry, revocation, scopes and owner bindings inside the execution transaction.
 * Browser session tokens must not be accepted by that external-token resolver.
 */
export interface McpCredentialInput { path: string; rawHeaders: readonly string[]; query: string }
export interface McpExternalCredential { readonly kind: 'external-token'; readonly token: string }
export function createMcpCredentialReader(config: { environment: string; allowUrlToken?: boolean }) {
  // Capture once: mutating startup configuration cannot enable query credentials.
  const allowUrlToken = config.allowUrlToken === true
  if (allowUrlToken && !['development', 'test'].includes(config.environment)) throw new Error('URL token requires explicit development or test environment')
  const deny = (): never => { throw Object.assign(new Error('Unauthorized'), { statusCode: 401 }) }
  const valid = (value: string) => /^[A-Za-z0-9_-]{43}$/.test(value)
  return (input: McpCredentialInput): Readonly<McpExternalCredential> => {
    if (!['/mcp', '/dev/mcp'].includes(input.path) || (input.path === '/dev/mcp' && !allowUrlToken)) return deny()
    if (input.query.length > 4096 || input.rawHeaders.length % 2 !== 0) return deny()
    const query = new URLSearchParams(input.query)
    const tokens = query.getAll('token')
    if (query.has('access_token')) return deny()
    const authorization: string[] = []
    for (let i = 0; i < input.rawHeaders.length; i += 2) {
      if (input.rawHeaders[i].toLowerCase() === 'authorization') authorization.push(input.rawHeaders[i + 1])
    }
    if (tokens.length) {
      if (!allowUrlToken || input.path !== '/dev/mcp' || authorization.length || tokens.length !== 1 || !valid(tokens[0])) return deny()
      return Object.freeze({ kind: 'external-token', token: tokens[0] })
    }
    if (authorization.length !== 1) return deny()
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(authorization[0])
    if (!match) return deny()
    return Object.freeze({ kind: 'external-token', token: match[1] })
  }
}
