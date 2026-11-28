import { createHash, timingSafeEqual } from 'node:crypto'

const algorithms = new Map([
  ['MD5', 'md5'], ['RIPEMD-160', 'ripemd160'], ['SHA-1', 'sha1'],
  ['SHA-256', 'sha256'], ['SHA-384', 'sha384'], ['SHA-512', 'sha512'],
])
const legacyAlgorithms = new Map([
  ['3', 'md5'], ['4', 'sha1'], ['12', 'sha256'], ['13', 'sha384'], ['14', 'sha512'],
])
const MAX_SPINS = 1_000_000

function decode(value: string | undefined, limit: number): Buffer | undefined {
  if (!value || value.length > Math.ceil(limit / 3) * 8) return
  const normalized = value.replace(/[\t\r\n ]/g, '')
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) return
  const result = Buffer.from(normalized, 'base64')
  if (result.length && result.length <= limit && result.toString('base64') === normalized) return result
}

/** Verify one supplied password using the presentation's declared verifier. */
export function verifyPptxModificationPassword(
  verifier: Readonly<Record<string, string>> | undefined,
  password: string,
): 'match' | 'incorrect' | 'unsupported' {
  if (!verifier || verifier.algIdExt !== undefined || verifier.cryptProviderTypeExt !== undefined) return 'unsupported'
  const iso = verifier.algorithmName !== undefined
  if (iso ? verifier.hashData !== undefined || verifier.saltData !== undefined || verifier.cryptAlgorithmSid !== undefined
    : verifier.hashValue !== undefined || verifier.saltValue !== undefined) return 'unsupported'
  const algorithm = iso ? algorithms.get(verifier.algorithmName!) : legacyAlgorithms.get(verifier.cryptAlgorithmSid ?? '')
  const salt = decode(iso ? verifier.saltValue : verifier.saltData, 65_536)
  const expected = decode(iso ? verifier.hashValue : verifier.hashData, 64)
  const spin = iso ? verifier.spinValue ?? verifier.spinCount : verifier.spinCount
  if (verifier.spinValue !== undefined && (!iso ||
      verifier.spinCount !== undefined && verifier.spinCount !== verifier.spinValue)) return 'unsupported'
  if (!algorithm || !salt || !expected || !/^\d{1,7}$/.test(spin ?? '')) return 'unsupported'
  const spins = Number(spin)
  if (spins > MAX_SPINS) return 'unsupported'
  const text = Buffer.from(password.replace(/^\uFEFF/, '').slice(0, 255), 'utf16le')
  try {
    // Salt-first order is also used by the PowerPoint-generated legacy
    // verifier in LibreOffice's tdf144943 interoperability fixture.
    let hash = createHash(algorithm).update(salt).update(text).digest()
    if (hash.length !== expected.length) return 'unsupported'
    const count = Buffer.alloc(4)
    for (let iteration = 0; iteration < spins; iteration++) {
      count.writeUInt32LE(iteration)
      hash = createHash(algorithm).update(hash).update(count).digest()
    }
    return timingSafeEqual(hash, expected) ? 'match' : 'incorrect'
  } catch {
    return 'unsupported'
  } finally {
    text.fill(0)
  }
}
