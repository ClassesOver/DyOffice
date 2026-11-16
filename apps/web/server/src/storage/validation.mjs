const FORMATS = new Set(['docx', 'xlsx', 'pptx', 'pdf'])

function reject(code, status = 400) {
  throw Object.assign(new Error(code), { code, status })
}

function zipMagic(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) return false
  return (bytes[2] === 0x03 && bytes[3] === 0x04)
    || (bytes[2] === 0x05 && bytes[3] === 0x06)
    || (bytes[2] === 0x07 && bytes[3] === 0x08)
}

/** Static office-object checks. The caller supplies an already authorized owner. */
export function validateOfficeObject({ name, bytes, maxBytes }) {
  if (typeof name !== 'string' || name.length === 0 || name.length > 255) reject('UNSAFE_NAME')
  if (name.includes('\0') || /[\\/]/.test(name) || name.includes('..')) reject('UNSAFE_NAME')
  const dot = name.lastIndexOf('.')
  const format = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
  if (!FORMATS.has(format)) reject('UNSUPPORTED_TYPE')
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) reject('EMPTY')
  if (!Number.isSafeInteger(maxBytes) || bytes.length > maxBytes) reject('OVERSIZE')
  if (format === 'pdf') {
    if (bytes.length < 5 || !bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) reject('MAGIC_MISMATCH')
  } else if (!zipMagic(bytes)) reject('MAGIC_MISMATCH')
  return { format }
}

export function assertOwnerId(ownerId) {
  if (typeof ownerId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,79}$/.test(ownerId)) reject('UNSAFE_OWNER')
  return ownerId
}
