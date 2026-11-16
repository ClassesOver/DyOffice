import {createSecretBox, type SecretKeyring} from './secrets.ts'

/** A deployment-supplied keyring, independent of CSRF and account credentials. */
export function parseConfigKeyring(input: string | undefined): SecretKeyring | undefined {
  if (input === undefined) return undefined
  try {
    if (input.length > 16_384) throw new Error()
    const value = JSON.parse(input)
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['activeKeyId', 'keys'].includes(key)) || !value.keys || typeof value.keys !== 'object' || Array.isArray(value.keys)) throw new Error()
    const keys: Record<string, Uint8Array> = Object.create(null)
    for (const [id, encoded] of Object.entries(value.keys)) {
      if (typeof encoded !== 'string') throw new Error()
      const decoded = Buffer.from(encoded, 'base64')
      if (decoded.length !== 32 || decoded.toString('base64') !== encoded) throw new Error()
      keys[id] = decoded
    }
    const keyring = {activeKeyId: value.activeKeyId, keys}
    createSecretBox(keyring)
    return keyring
  } catch { throw new Error('Invalid global configuration keyring') }
}
