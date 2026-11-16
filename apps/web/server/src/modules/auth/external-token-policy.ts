/** Pure post-lookup policy only. Callers MUST obtain records under trusted database
 * locks and revalidate before commit. This does not authenticate a raw token,
 * create a BusinessPrincipal, or authorize any route. */
export interface ExternalTokenRecord {
  deploymentId: string; ownerId: string; audience: string; authVersion: number;
  expiresAt: number; revokedAt: number | null; scopes: readonly string[];
}
export interface ExternalTokenUser {
  deploymentId: string; id: string; status: string; passwordResetRequired: boolean;
  authVersion: number; scopes: readonly string[];
}
const allowed = new Set(['files:read', 'files:write'])
export function authorizeExternalTokenRecord(input: {
  deploymentId: string; audience: string; now: number;
  record: ExternalTokenRecord; user: ExternalTokenUser;
}) {
  const { record: r, user: u, deploymentId, audience, now } = input
  const deny = () => { throw new Error('Access denied') }
  if (!r || !u || !deploymentId || !audience || !Number.isSafeInteger(now) || now < 0 ||
      !Number.isSafeInteger(r.expiresAt) || r.expiresAt <= now || r.revokedAt !== null ||
      r.deploymentId !== deploymentId || u.deploymentId !== deploymentId || !r.ownerId || r.ownerId !== u.id ||
      r.audience !== audience || !Number.isSafeInteger(r.authVersion) || r.authVersion < 1 ||
      r.authVersion !== u.authVersion || u.status !== 'active' || u.passwordResetRequired !== false ||
      !Array.isArray(r.scopes) || !Array.isArray(u.scopes) || r.scopes.length > allowed.size ||
      r.scopes.some(scope => !allowed.has(scope)) || new Set(r.scopes).size !== r.scopes.length) return deny()
  return Object.freeze({kind: 'external-token' as const, deploymentId, userId: u.id,
    authVersion: u.authVersion, scopes: Object.freeze(r.scopes.filter(scope => u.scopes.includes(scope)))})
}
