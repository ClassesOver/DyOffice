import { createHash } from 'node:crypto'
import { crc32 } from 'node:zlib'
import { fromBufferPromise } from 'yauzl'
import { XMLParser, XMLValidator } from 'fast-xml-parser'
import { decodeCsvBuffer } from '@genoffice/xlsx-gateway/gateway/csv-import'
import type { WorkspaceFileFormat } from '../../../../../../packages/web-contracts/src/api.ts'
import { MAX_OBJECT_BYTES, storageError } from '../../storage/object-store.ts'
import { validatePdf } from './pdf-validation.mjs'

export const uploadLimits = Object.freeze({ maxBytes: MAX_OBJECT_BYTES, maxEntries: 4096, maxPartBytes: 32 * 1024 * 1024, maxInflatedBytes: 128 * 1024 * 1024, maxXmlBytes: 4 * 1024 * 1024 })
export interface FileValidationPolicy { maxBytes: number; maxEntries: number; maxPartBytes: number; maxInflatedBytes: number; maxXmlBytes: number }
export type FileValidationOptions = Partial<FileValidationPolicy> & { allowEncryptedPdf?: boolean }
type Limits = FileValidationPolicy
const opcSignatureOrigin = 'http://schemas.openxmlformats.org/package/2006/relationships/digital-signature/origin'
const opcSignatureTypes = new Set([
  'application/vnd.openxmlformats-package.digital-signature-origin',
  'application/vnd.openxmlformats-package.digital-signature-xmlsignature+xml',
  'application/vnd.openxmlformats-package.digital-signature-certificate',
])
const definitions = {
  docx: { path: 'word/document.xml', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml', root: 'document', namespace: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  xlsx: { path: 'xl/workbook.xml', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml', root: 'workbook', namespace: 'http://schemas.openxmlformats.org/spreadsheetml/2006/main', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  xlsm: { path: 'xl/workbook.xml', type: 'application/vnd.ms-excel.sheet.macroEnabled.main+xml', root: 'workbook', namespace: 'http://schemas.openxmlformats.org/spreadsheetml/2006/main', mime: 'application/vnd.ms-excel.sheet.macroEnabled.12' },
  pptx: { path: 'ppt/presentation.xml', type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml', root: 'presentation', namespace: 'http://schemas.openxmlformats.org/presentationml/2006/main', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
} as const

export function validateFileName(name: string): WorkspaceFileFormat {
  if (typeof name !== 'string' || name.trim() !== name || Buffer.byteLength(name) > 255 || name.startsWith('.') || /[\\/\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(name)) throw storageError(400)
  const format = name.split('.').at(-1)?.toLowerCase()
  if (!['docx','xlsx','pptx','pdf','csv','xlsm'].includes(format ?? '') || !name.includes('.')) throw storageError(400)
  return format as WorkspaceFileFormat
}

function xmlRoot(bytes: Buffer, expected: string, namespace: string): Record<string, unknown> {
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8'
  const xml = new TextDecoder(encoding, { fatal: true }).decode(bytes)
  if (/<!\s*(?:DOCTYPE|ENTITY)/i.test(xml) || XMLValidator.validate(xml) !== true) throw storageError(400)
  const parsed = new XMLParser({ ignoreAttributes: false, processEntities: false, parseTagValue: false, parseAttributeValue: false }).parse(xml)
  const names = Object.keys(parsed).filter(name => !name.startsWith('?'))
  if (names.length !== 1) throw storageError(400)
  const name = names[0], value = parsed[name]
  const prefix = name.includes(':') ? name.split(':')[0] : ''
  if (name.split(':').at(-1) !== expected || !value || typeof value !== 'object' || value[prefix ? '@_xmlns:' + prefix : '@_xmlns'] !== namespace) throw storageError(400)
  return value
}
function children(root: Record<string, unknown>, name: string, namespace: string): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = []
  for (const [key, value] of Object.entries(root)) {
    if (key.startsWith('@_') || key.split(':').at(-1) !== name) continue
    const prefix = key.includes(':') ? key.split(':')[0] : ''
    const declaration = prefix ? '@_xmlns:' + prefix : '@_xmlns'
    for (const child of Array.isArray(value) ? value : [value]) {
      if (!child || typeof child !== 'object' || (child[declaration] ?? root[declaration]) !== namespace) throw storageError(400)
      found.push(child)
    }
  }
  return found
}

function signatureAttribute(value: unknown) {
  if (typeof value !== 'string') return ''
  // The signature identifiers are ASCII. Resolve numeric references without enabling XML entities.
  return value.replace(/&#(x[0-9a-fA-F]+|[0-9]+);/g, (reference, digits: string) => {
    const code = digits.startsWith('x') ? Number.parseInt(digits.slice(1), 16) : Number.parseInt(digits, 10)
    return code >= 0x20 && code <= 0x7e ? String.fromCharCode(code) : reference
  })
}

async function readBoundedZip(bytes: Buffer, limits: Limits, isStructuralPart: (name: string) => boolean, allowVba = false) {
  // Reject ZIP64, split archives and trailing junk before opening any entries.
  let end = -1
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 65535); at--) {
    if (bytes.readUInt32LE(at) === 0x06054b50 && at + 22 + bytes.readUInt16LE(at + 20) === bytes.length) { end = at; break }
  }
  if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || bytes.readUInt16LE(end + 8) !== bytes.readUInt16LE(end + 10) || bytes.readUInt16LE(end + 10) === 65535 || bytes.readUInt32LE(end + 12) === 0xffffffff || bytes.readUInt32LE(end + 16) === 0xffffffff || (end >= 20 && bytes.readUInt32LE(end - 20) === 0x07064b50)) throw storageError(400)
  const directory = bytes.readUInt32LE(end + 16)
  if (directory + bytes.readUInt32LE(end + 12) !== end) throw storageError(400)
  const zip = await fromBufferPromise(bytes, { lazyEntries: true, autoClose: false, strictFileNames: true, validateEntrySizes: true })
  const names = new Set<string>(), parts = new Map<string, Buffer>()
  let total = 0, count = 0
  try {
    if (zip.entryCount > limits.maxEntries) throw storageError(413)
    for await (const entry of zip.eachEntry()) {
      if (++count > limits.maxEntries || entry.uncompressedSize > limits.maxPartBytes || total + entry.uncompressedSize > limits.maxInflatedBytes) throw storageError(413)
      const name = entry.fileName
      if (names.has(name.toLowerCase()) || name.includes('\\') || name.includes('\0') || name.split('/').some(segment => segment === '..' || segment === '.') || name.startsWith('/') || (!allowVba && /vbaProject/i.test(name)) || entry.isEncrypted() || ![0,8].includes(entry.compressionMethod) || entry.versionNeededToExtract >= 45 || ((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000) throw storageError(400)
      names.add(name.toLowerCase())
      const header = await zip.readLocalFileHeaderPromise(entry)
      if (!header.fileName.equals(entry.fileNameRaw) || header.generalPurposeBitFlag !== entry.generalPurposeBitFlag || header.compressionMethod !== entry.compressionMethod || header.fileDataStart + entry.compressedSize > directory) throw storageError(400)
      if (!(entry.generalPurposeBitFlag & 8) && (header.crc32 !== entry.crc32 || header.compressedSize !== entry.compressedSize || header.uncompressedSize !== entry.uncompressedSize)) throw storageError(400)
      const structural = isStructuralPart(name)
      if (structural && entry.uncompressedSize > limits.maxXmlBytes) throw storageError(413)
      const chunks: Buffer[] = [], stream = await zip.openReadStreamPromise(entry)
      let size = 0, crc = 0
      try {
        for await (const chunk of stream) {
          size += chunk.length; total += chunk.length
          if (size > entry.uncompressedSize || size > limits.maxPartBytes || total > limits.maxInflatedBytes) throw storageError(400)
          crc = crc32(chunk, crc)
          if (structural) chunks.push(chunk)
        }
      } finally { stream.destroy() }
      if (size !== entry.uncompressedSize || crc !== entry.crc32) throw storageError(400)
      if (structural) parts.set(name, Buffer.concat(chunks, size))
    }
  } finally { zip.close() }
  return parts
}

function validateImportXml(parts: Map<string, Buffer>) {
  for (const xml of parts.values()) {
    const source = new TextDecoder('utf-8', { fatal: true }).decode(xml)
    if (/<!\s*(?:DOCTYPE|ENTITY)/i.test(source) || XMLValidator.validate(source) !== true) throw storageError(400)
  }
}

export async function validateOdfInput(bytes: Buffer) {
  const parts = await readBoundedZip(bytes, uploadLimits, name => name === 'content.xml' || name === 'styles.xml')
  if (!parts.has('content.xml')) throw storageError(400)
  validateImportXml(parts)
}

export async function validateHwpxInput(bytes: Uint8Array) {
  if (bytes.byteLength > uploadLimits.maxBytes) throw storageError(413)
  const zip = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const parts = await readBoundedZip(zip, uploadLimits, name => /\.(xml|hpf)$/i.test(name))
  if (!parts.has('Contents/header.xml')) throw storageError(400)
  validateImportXml(parts)
}

async function validateOffice(bytes: Buffer, format: keyof typeof definitions, limits: Limits) {
  const definition = definitions[format]
  const required = ['[Content_Types].xml','_rels/.rels',definition.path]
  const parts = await readBoundedZip(bytes, limits, name => required.includes(name), format === 'xlsm')
  if (!required.every(name => parts.has(name))) throw storageError(400)
  const types = xmlRoot(parts.get('[Content_Types].xml')!, 'Types', 'http://schemas.openxmlformats.org/package/2006/content-types')
  const overrides = children(types, 'Override', 'http://schemas.openxmlformats.org/package/2006/content-types')
  const contentTypes = [...children(types,'Default', 'http://schemas.openxmlformats.org/package/2006/content-types'),...overrides].map(item => String(item['@_ContentType']))
  if (overrides.filter(item => item['@_PartName'] === '/' + definition.path && item['@_ContentType'] === definition.type).length !== 1) throw storageError(400)
  // VBA is an opaque archive part of an explicitly macro-enabled spreadsheet.
  // Ordinary Office packages keep their existing macro rejection.
  if (contentTypes.some(type => /macroEnabled|vbaProject/i.test(type) &&
      (format !== 'xlsm' || (type !== definition.type && !/^application\/vnd\.ms-office\.vbaProject(?:Signature(?:Agile|V3)?)?$/i.test(type))))) throw storageError(400)
  const relations = xmlRoot(parts.get('_rels/.rels')!, 'Relationships', 'http://schemas.openxmlformats.org/package/2006/relationships')
  const relationships = children(relations,'Relationship', 'http://schemas.openxmlformats.org/package/2006/relationships')
  const roots = relationships.filter(item => item['@_Type'] === 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument')
  if (roots.length !== 1 || roots[0]['@_TargetMode'] === 'External' || ![definition.path,'/' + definition.path].includes(String(roots[0]['@_Target']))) throw storageError(400)
  xmlRoot(parts.get(definition.path)!, definition.root, definition.namespace)
  return relationships.some(item => signatureAttribute(item['@_Type']) === opcSignatureOrigin) ||
    contentTypes.some(type => opcSignatureTypes.has(signatureAttribute(type).toLowerCase()))
}

export async function validateUploadInternal(bytes: Buffer, name: string, { allowEncryptedPdf = false, ...policy }: FileValidationOptions = {}) {
  const format = validateFileName(name), limits = { ...uploadLimits,...policy }
  if (Object.values(limits).some(value => !Number.isSafeInteger(value) || value < 1)) throw storageError(400)
  if (!Buffer.isBuffer(bytes) || (bytes.length === 0 && format !== 'csv')) throw storageError(400)
  if (bytes.length > limits.maxBytes || bytes.length > MAX_OBJECT_BYTES) throw storageError(413)
  let officeSignatureProtected = false
  try {
    if (format === 'csv') {
      const text = decodeCsvBuffer(bytes)
      // Tab and line breaks are valid CSV data. Binary office packages are not.
      if (bytes.subarray(0,5).toString('ascii') === '%PDF-' || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text) ||
          bytes.subarray(0,4).toString('hex') === '504b0304' || bytes.subarray(0,8).toString('hex') === 'd0cf11e0a1b11ae1') throw storageError(400)
    } else if (format === 'pdf') return Object.freeze(await validatePdf(bytes, allowEncryptedPdf))
    else officeSignatureProtected = await validateOffice(bytes, format, limits)
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode === 413) throw error
    throw storageError(400)
  }
  return Object.freeze({ format, mime: format === 'csv' ? 'text/csv' : definitions[format].mime, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), officeSignatureProtected })
}
