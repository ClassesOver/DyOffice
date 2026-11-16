import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

export interface SecretKeyring { activeKeyId: string; keys: Record<string, Uint8Array> }
export interface SecretContext { deploymentId: string; configId: string; providerId: string; kind: string }
export interface SecretEnvelope { version: 1; algorithm: 'A256GCM'; keyId: string; iv: string; tag: string; ciphertext: string }
const unavailable = () => Object.assign(new Error('Secret storage unavailable'), { statusCode: 503 })
const keyIdPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/
function additionalData(context: SecretContext, keyId: string) {
  const fields = [context.deploymentId, context.configId, context.providerId, context.kind]
  if (fields.some(value => typeof value !== 'string' || !value || value.length > 128)) throw unavailable()
  return Buffer.from(JSON.stringify(['dyoffice.global-config', 1, keyId, ...fields]))
}
function decode(value: unknown, length?: number) {
  if (typeof value !== 'string' || !value || value.length > 16384) throw unavailable()
  const bytes = Buffer.from(value, 'base64')
  if (bytes.toString('base64') !== value || (length !== undefined && bytes.length !== length)) throw unavailable()
  return bytes
}
/** Keys are supplied by deployment configuration, copied once, and never generated at startup. */
export function createSecretBox(keyring: SecretKeyring) {
  if (!keyring || typeof keyring !== 'object' || !keyIdPattern.test(keyring.activeKeyId) || !keyring.keys || typeof keyring.keys !== 'object' || Array.isArray(keyring.keys)) throw new Error('Invalid secret keyring')
  const keys = new Map<string, Buffer>()
  for (const [id, bytes] of Object.entries(keyring.keys)) {
    if (!keyIdPattern.test(id) || !(bytes instanceof Uint8Array) || bytes.byteLength !== 32) throw new Error('Invalid secret keyring')
    keys.set(id, Buffer.from(bytes))
  }
  if (!keys.has(keyring.activeKeyId) || keys.size > 32) throw new Error('Invalid secret keyring')
  const activeKeyId = keyring.activeKeyId
  return {
    activeKeyId,
    seal(plaintext: string, context: SecretContext): SecretEnvelope {
      if (typeof plaintext !== 'string' || !plaintext || Buffer.byteLength(plaintext) > 8192) throw unavailable()
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', keys.get(activeKeyId)!, iv)
      cipher.setAAD(additionalData(context, activeKeyId))
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
      return { version: 1, algorithm: 'A256GCM', keyId: activeKeyId, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') }
    },
    unseal(input: unknown, context: SecretContext): string {
      try {
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw unavailable()
        const value = input as SecretEnvelope
        if (Object.keys(value).some(key => !['version','algorithm','keyId','iv','tag','ciphertext'].includes(key)) || value.version !== 1 || value.algorithm !== 'A256GCM' || !keys.has(value.keyId)) throw unavailable()
        const decipher = createDecipheriv('aes-256-gcm', keys.get(value.keyId)!, decode(value.iv, 12))
        decipher.setAAD(additionalData(context, value.keyId)); decipher.setAuthTag(decode(value.tag, 16))
        const plaintext = Buffer.concat([decipher.update(decode(value.ciphertext)), decipher.final()])
        if (!plaintext.length || plaintext.length > 8192) throw unavailable()
        return plaintext.toString('utf8')
      } catch { throw unavailable() }
    },
  }
}

