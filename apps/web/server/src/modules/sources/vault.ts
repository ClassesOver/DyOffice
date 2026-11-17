import { createHash } from 'node:crypto'
import { createSecretBox, type SecretEnvelope } from '../admin/secrets.ts'

interface VaultScope { deploymentId: string; ownerId: string; sourceId: string; reference: string; revision: number }
const unavailable = () => Object.assign(new Error('Source credential unavailable'), { statusCode: 503 })
/** First key encrypts new immutable revisions; retained keys decrypt history.
 * Reuse the provider AES-GCM envelope with a source-specific AAD namespace and a
 * digest binding owner/source/reference/revision (never an HTTP-supplied context).
 */
export function createCredentialVault(raw = '') {
  let box: ReturnType<typeof createSecretBox> | undefined
  if (raw) {
    const keys: Record<string, Uint8Array> = Object.create(null)
    const entries = raw.split(',')
    for (const entry of entries) {
      const i = entry.indexOf(':'), id = entry.slice(0, i), encoded = entry.slice(i + 1), bytes = Buffer.from(encoded, 'base64')
      if (i < 1 || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(id) || Object.hasOwn(keys, id) || bytes.length !== 32 || bytes.toString('base64') !== encoded) throw new Error('Invalid source credential keys')
      keys[id] = bytes
    }
    box = createSecretBox({ activeKeyId: entries[0].split(':')[0], keys })
  }
  const context = (scope: VaultScope) => ({ deploymentId: scope.deploymentId, configId: createHash('sha256').update(JSON.stringify([scope.ownerId, scope.sourceId, scope.reference, scope.revision])).digest('hex'), providerId: 'source-credential', kind: 'source-vault-v1' })
  return Object.freeze({
    get available() { return !!box },
    seal(secret: string, scope: VaultScope): SecretEnvelope { if (!box) throw unavailable(); return box.seal(secret, context(scope)) },
    open(envelope: unknown, scope: VaultScope): string { if (!box) throw unavailable(); return box.unseal(envelope, context(scope)) },
  })
}
export type CredentialVault = ReturnType<typeof createCredentialVault>
