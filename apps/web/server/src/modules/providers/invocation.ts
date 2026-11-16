/**
 * Unmounted validation primitive, NOT authorization or a spend/secret capability.
 * All inputs except requested model/turn must come from trusted server adapters.
 * Deployment-owned/shared credentials are deliberately unsupported in this stage.
 */
export interface ProviderInvocationPlan {
  readonly deploymentId: string; readonly userId: string; readonly sessionId: string
  readonly turnId: string; readonly modelId: string; readonly configId: string; readonly revision: string
  readonly credentialRef: string; readonly egressProfileId: string; readonly endpoint: string
  readonly reservationId: string; readonly maxInputTokens: number; readonly maxOutputTokens: number
}
const unavailable = () => new Error('Provider invocation unavailable')
function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== keys.length || keys.some(k => !Object.hasOwn(value,k))) throw unavailable()
  return value as Record<string,unknown>
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw unavailable()
  return value
}
function positive(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw unavailable()
  return value
}
const binding = ['deploymentId','userId','sessionId','turnId','modelId','configId','revision']
export function prepareProviderInvocation(input: unknown): Readonly<ProviderInvocationPlan> {
  try {
    const x = record(input,['identity','turnId','modelId','now','grant','reservation','profiles'])
    const identity = record(x.identity,['deploymentId','userId','sessionId'])
    const grant = record(x.grant,[...binding,'enabled','expiresAt','credential','egressProfileId'])
    const reservation = record(x.reservation,[...binding,'id','state','expiresAt','maxInputTokens','maxOutputTokens'])
    const credential = record(grant.credential,['deploymentId','ownerId','ref'])
    if (typeof x.now !== 'number' || !Number.isSafeInteger(x.now) || x.now < 0) throw unavailable()
    for (const key of binding) {
      if (id(grant[key]) !== id(reservation[key])) throw unavailable()
    }
    for (const key of ['deploymentId','userId','sessionId']) if (id(identity[key]) !== grant[key]) throw unavailable()
    if (id(x.turnId) !== grant.turnId || id(x.modelId) !== grant.modelId ||
        grant.enabled !== true || reservation.state !== 'reserved' ||
        positive(grant.expiresAt) <= x.now || positive(reservation.expiresAt) <= x.now ||
        id(credential.deploymentId) !== grant.deploymentId || id(credential.ownerId) !== grant.userId) throw unavailable()
    if (!Array.isArray(x.profiles) || x.profiles.length > 256) throw unavailable()
    const profileId = id(grant.egressProfileId)
    const profiles = x.profiles.map(p => record(p,['id','deploymentId','revision','protocol','endpoint']))
    const matches = profiles.filter(p => p.id === profileId)
    if (matches.length !== 1) throw unavailable()
    const profile = matches[0]!
    if (id(profile.deploymentId) !== grant.deploymentId || id(profile.revision) !== grant.revision ||
        profile.protocol !== 'openai-chat' || typeof profile.endpoint !== 'string') throw unavailable()
    const url = new URL(profile.endpoint)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
        profile.endpoint !== url.href) throw unavailable()
    // This is an exact trusted egress profile, not an SSRF/DNS safety check.
    // A future pinned transport must enforce public-address DNS, redirect:none,
    // peer binding, deadlines and response limits. This module never sends.
    return Object.freeze({
      deploymentId:id(grant.deploymentId),userId:id(grant.userId),sessionId:id(grant.sessionId),
      turnId:id(grant.turnId),modelId:id(grant.modelId),configId:id(grant.configId),revision:id(grant.revision),
      credentialRef:id(credential.ref),egressProfileId:profileId,endpoint:url.href,
      reservationId:id(reservation.id),maxInputTokens:positive(reservation.maxInputTokens),
      maxOutputTokens:positive(reservation.maxOutputTokens),
    })
  } catch { throw unavailable() }
}
