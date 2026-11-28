import { createDecipheriv, createHash, createHmac, timingSafeEqual } from 'node:crypto'
import * as CFB from 'cfb'
import { XMLParser, XMLValidator } from 'fast-xml-parser'
import officeCrypto from 'officecrypto-tool'
import type { EncryptedOfficeFormat } from '../../../../../../packages/web-contracts/src/api.ts'
import { MAX_OBJECT_BYTES, storageError } from '../../storage/object-store.ts'
import { validateUploadInternal } from './validation-core.ts'

const cfbMagic = Buffer.from('d0cf11e0a1b11ae1', 'hex')
const agileHeader = Buffer.from('0400040040000000', 'hex')
const passwordUri = 'http://schemas.microsoft.com/office/2006/keyEncryptor/password'
const verifierInput = Buffer.from('fea7d2763b4b9e79', 'hex')
const verifierValue = Buffer.from('d7aa0f6d3061344e', 'hex')
const packageKeyBlock = Buffer.from('146e0be7abacd0d6', 'hex')
const hmacKeyBlock = Buffer.from('5fb2ad010cb9e1f6', 'hex')
const hmacValueBlock = Buffer.from('a0677f02b22c8433', 'hex')
const hashes = new Map([['sha1', 20], ['sha256', 32], ['sha384', 48], ['sha512', 64]])
const blockSize = 16

const invalid = () => Object.assign(storageError(400), { code: 'WORKBOOK_ENCRYPTION_INVALID' })
const wrongPassword = () => Object.assign(storageError(422), { code: 'WORKBOOK_PASSWORD_INVALID' })

function integer(value: unknown, max: number): number {
  if (typeof value !== 'string' || !/^\d+$/.test(value) || Number(value) > max) throw invalid()
  return Number(value)
}

function base64(value: unknown): Buffer {
  if (typeof value !== 'string' || !value || value.length > 256) throw invalid()
  const decoded = Buffer.from(value, 'base64')
  if (decoded.toString('base64') !== value) throw invalid()
  return decoded
}

function parameters(data: Record<string, unknown> | undefined) {
  const algorithm = String(data?.hashAlgorithm).toLowerCase().replaceAll('-', '')
  const hashSize = hashes.get(algorithm)
  if (!data || !hashSize || data.hashSize !== String(hashSize) || data.blockSize !== '16' ||
      data.cipherAlgorithm !== 'AES' || data.cipherChaining !== 'ChainingModeCBC') throw invalid()
  const keyBits = integer(data.keyBits, 256)
  if (![128, 192, 256].includes(keyBits)) throw invalid()
  const salt = base64(data.saltValue)
  if (salt.length !== blockSize || data.saltSize !== String(salt.length)) throw invalid()
  return { algorithm, hashSize, keyBytes: keyBits / 8, salt }
}

function digest(algorithm: string, ...chunks: Buffer[]): Buffer {
  const hash = createHash(algorithm)
  for (const chunk of chunks) hash.update(chunk)
  return hash.digest()
}

function decrypt(key: Buffer, iv: Buffer, ciphertext: Buffer): Buffer {
  if (ciphertext.length % blockSize) throw invalid()
  const cipher = createDecipheriv(`aes-${key.length * 8}-cbc`, key, iv)
  cipher.setAutoPadding(false)
  return Buffer.concat([cipher.update(ciphertext), cipher.final()])
}

function openAgile(info: Buffer, encrypted: Buffer, size: number, password: string): Buffer {
  const xml = new TextDecoder('utf-8', { fatal: true }).decode(info.subarray(8))
  if (/<!\s*(?:DOCTYPE|ENTITY)/i.test(xml) || XMLValidator.validate(xml) !== true) throw invalid()
  const root = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', removeNSPrefix: true, processEntities: false, parseTagValue: false }).parse(xml)?.encryption
  const candidates = root?.keyEncryptors?.keyEncryptor
  const entries = Array.isArray(candidates) ? candidates : [candidates]
  const matching = entries.filter(entry => entry?.uri === passwordUri)
  if (matching.length !== 1) throw invalid()
  const protector = matching[0].encryptedKey
  const keyData = parameters(protector)
  const packageData = parameters(root.keyData)
  const spins = integer(protector.spinCount, 10_000_000)
  const counter = Buffer.alloc(4)
  let hash = digest(keyData.algorithm, keyData.salt, Buffer.from(password, 'utf16le'))
  for (let i = 0; i < spins; i++) {
    counter.writeUInt32LE(i)
    hash = digest(keyData.algorithm, counter, hash)
  }
  const unwrap = (block: Buffer, value: unknown) => {
    const material = digest(keyData.algorithm, hash, block)
    const key = Buffer.alloc(keyData.keyBytes, 0x36)
    material.copy(key, 0, 0, key.length)
    return decrypt(key, keyData.salt, base64(value))
  }
  const verifier = unwrap(verifierInput, protector.encryptedVerifierHashInput)
  const expected = unwrap(verifierValue, protector.encryptedVerifierHashValue).subarray(0, keyData.hashSize)
  if (verifier.length !== keyData.salt.length || expected.length !== keyData.hashSize) throw invalid()
  if (!timingSafeEqual(digest(keyData.algorithm, verifier), expected)) throw wrongPassword()
  const key = unwrap(packageKeyBlock, protector.encryptedKeyValue).subarray(0, packageData.keyBytes)
  if (key.length !== packageData.keyBytes || encrypted.length !== 8 + Math.ceil(size / blockSize) * blockSize) throw invalid()

  const iv = (block: Buffer) => digest(packageData.algorithm, packageData.salt, block).subarray(0, blockSize)
  const hmacKey = decrypt(key, iv(hmacKeyBlock), base64(root.dataIntegrity?.encryptedHmacKey))
  const expectedHmac = decrypt(key, iv(hmacValueBlock), base64(root.dataIntegrity?.encryptedHmacValue)).subarray(0, packageData.hashSize)
  const actualHmac = createHmac(packageData.algorithm, hmacKey).update(encrypted).digest()
  if (expectedHmac.length !== actualHmac.length || !timingSafeEqual(actualHmac, expectedHmac)) throw invalid()

  const result = Buffer.alloc(size)
  for (let at = 0; at < size; at += 4096) {
    counter.writeUInt32LE(at / 4096)
    decrypt(key, iv(counter), encrypted.subarray(8 + at, 8 + at + 4096)).copy(result, at)
  }
  return result
}

async function openContainer(bytes: Buffer, password: string): Promise<Buffer> {
  if (!bytes.subarray(0, 8).equals(cfbMagic)) throw invalid()
  try {
    const container = CFB.read(bytes, { type: 'buffer' })
    const info = CFB.find(container, '/EncryptionInfo')?.content
    const encrypted = CFB.find(container, '/EncryptedPackage')?.content
    if (!Buffer.isBuffer(info) || info.length < 8 || info.length > 65536 || !Buffer.isBuffer(encrypted) || encrypted.length < 24) throw invalid()
    const size = encrypted.readBigUInt64LE()
    if (size < 1n || size > BigInt(MAX_OBJECT_BYTES)) throw invalid()
    if (info.subarray(0, 8).equals(agileHeader)) return openAgile(info, encrypted, Number(size), password)
    if (![2, 3, 4].includes(info.readUInt16LE(0)) || info.readUInt16LE(2) !== 2) throw invalid()
    const result = await officeCrypto.decrypt(bytes, { password })
    if (result.length !== Number(size)) throw invalid()
    return result
  } catch (error) {
    if ((error as { code?: string }).code === 'WORKBOOK_PASSWORD_INVALID' || /password is incorrect/i.test(String(error))) throw wrongPassword()
    throw invalid()
  }
}

export async function transformProtectedWorkbook(operation: 'open' | 'seal', input: Buffer, password: string, format:EncryptedOfficeFormat='xlsx') {
  const plain = operation === 'open' ? await openContainer(input, password) : input
  const metadata = await validateUploadInternal(plain, `document.${format}`)
  const encrypted = operation === 'seal' ? officeCrypto.encrypt(plain, { password }) : input
  if (encrypted.length > MAX_OBJECT_BYTES) throw storageError(413)
  return {
    bytes: operation === 'open' ? plain : encrypted,
    file: { ...metadata, format, size: encrypted.length, sha256: digest('sha256', encrypted).toString('hex') },
  }
}
