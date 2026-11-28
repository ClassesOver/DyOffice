import { HostError, hostError } from '../../web-contracts/src/errors.ts'
import type { RevisionRef, SaveInput } from '../../web-contracts/src/api.ts'
import { isRevisionRef, isSaveInput } from '../../web-contracts/src/api.ts'
import { UNSUPPORTED_CAPABILITIES } from '../../web-contracts/src/host.ts'
import type { BrowserHost, CapabilityCatalog } from '../../web-contracts/src/host.ts'
import { DOCUMENT_THEME_MODES } from '../../web-contracts/src/preferences.ts'

const CAPABILITIES = new Set(['unsupported', 'read_only', 'editable'])
const ALLOWED_PREFS = new Set(['theme', 'documentTheme', 'language', 'authorName', 'autoSave', 'showAssistant'])
function nonempty(value: string, field: string): void {
  if (typeof value !== 'string' || !value.length) throw new HostError('INVALID_RESPONSE', `Missing ${field}`)
}
function safeCapabilities(value: unknown): CapabilityCatalog {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw hostError('INVALID_RESPONSE', 'getCapabilities')
  const v = value as Record<string, unknown>
  if (!['docx', 'xlsx', 'pptx', 'pdf'].every(k => typeof v[k] === 'string' && CAPABILITIES.has(v[k]))) throw hostError('INVALID_RESPONSE', 'getCapabilities')
  return { docx: v.docx, xlsx: v.xlsx, pptx: v.pptx, pdf: v.pdf } as CapabilityCatalog
}

// Contract fields only: caller-supplied identity (ownerId, deploymentId) never reaches the adapter.
function pickSaveInput(v: SaveInput): SaveInput {
  const { fileId, uploadId, baseRevision, idempotencyKey, leaseEpoch, sourceCommandId } = v
  return sourceCommandId === undefined
    ? { fileId, uploadId, baseRevision, idempotencyKey, leaseEpoch }
    : { fileId, uploadId, baseRevision, idempotencyKey, leaseEpoch, sourceCommandId }
}
/** A same-origin absolute path: no scheme, no protocol-relative `//`, no backslash or whitespace. */
function isSameOriginPath(value: unknown): value is string {
  return typeof value === 'string' && /^\/(?![/\\])[^\s\\]*$/.test(value)
}

function availableCapabilities(declared: CapabilityCatalog, adapter: Partial<BrowserHost>): CapabilityCatalog {
  const canRead = typeof adapter.open === 'function' && typeof adapter.readBytes === 'function'
  const canWrite = canRead && typeof adapter.stageSave === 'function' && typeof adapter.commitSave === 'function'
  return Object.fromEntries(
    (['docx', 'xlsx', 'pptx', 'pdf'] as const).map(format => [
      format, !canRead ? 'unsupported' : declared[format] === 'editable' && !canWrite ? 'read_only' : declared[format],
    ]),
  ) as CapabilityCatalog
}

function publicRevision(value: RevisionRef): RevisionRef {
  return { fileId: value.fileId, revision: value.revision, sha256: value.sha256, size: value.size }
}

/** Explicit Web adapter: missing methods fail closed rather than pretending desktop IPC works. */
export function createBrowserHost(adapter: Partial<BrowserHost> = {}): BrowserHost {
  return {
    async getCapabilities() {
      if (!adapter.getCapabilities) return UNSUPPORTED_CAPABILITIES
      return availableCapabilities(safeCapabilities(await adapter.getCapabilities()), adapter)
    },
    async open(fileId) {
      nonempty(fileId, 'fileId')
      if (!adapter.open) throw hostError('UNSUPPORTED', 'open')
      const result = await adapter.open(fileId)
      if (!result || !isRevisionRef(result.file) || result.file.fileId !== fileId || !['docx','xlsx','pptx','pdf'].includes(result.format) || !isSameOriginPath(result.downloadEndpoint)) throw hostError('INVALID_RESPONSE', 'open')
      if (result.name !== undefined && (typeof result.name !== 'string' || !result.name.length || result.name.length > 255 || /[\\/\u0000-\u001f]/.test(result.name))) throw hostError('INVALID_RESPONSE', 'file name')
      return {
        ...(result.name === undefined ? {} : { name: result.name }),
        ...(result.format !== 'pdf' && result.autoNamePending === true ? { autoNamePending: true as const } : {}),
        ...(result.format === 'pdf' && result.pdfAutoNamePending === true ? { pdfAutoNamePending: true as const } : {}),
        ...(result.format !== 'pdf' && result.officeSignatureProtected === true ? { officeSignatureProtected: true as const } : {}),
        ...(result.format === 'xlsx' && result.workbookPasswordProtected === true ? { workbookPasswordProtected: true as const } : {}),
        ...(result.format === 'docx' && result.documentPasswordProtected === true ? { documentPasswordProtected: true as const } : {}),
        file: publicRevision(result.file),
        format: result.format,
        downloadEndpoint: result.downloadEndpoint,
        capabilities: availableCapabilities(safeCapabilities(result.capabilities), adapter),
      }
    },
    async readBytes(fileId, revision) {
      nonempty(fileId, 'fileId'); nonempty(revision, 'revision')
      if (!adapter.readBytes) throw hostError('UNSUPPORTED', 'readBytes')
      const result = await adapter.readBytes(fileId, revision)
      if (!(result instanceof Uint8Array)) throw hostError('INVALID_RESPONSE', 'readBytes')
      return result
    },
    async stageSave(bytes, fileId) {
      nonempty(fileId, 'fileId')
      if (!(bytes instanceof Uint8Array) || !bytes.byteLength) throw hostError('INVALID_RESPONSE', 'stageSave')
      if (!adapter.stageSave) throw hostError('UNSUPPORTED', 'stageSave')
      const result = await adapter.stageSave(bytes, fileId)
      if (!result || typeof result.uploadId !== 'string' || !result.uploadId) throw hostError('INVALID_RESPONSE', 'stageSave')
      return { uploadId: result.uploadId }
    },
    async commitSave(input) {
      if (!isSaveInput(input)) throw hostError('INVALID_REVISION', 'commitSave')
      if (!adapter.commitSave) throw hostError('UNSUPPORTED', 'commitSave')
      const revision = await adapter.commitSave(pickSaveInput(input))
      if (!isRevisionRef(revision) || revision.fileId !== input.fileId) throw hostError('INVALID_RESPONSE', 'commitSave')
      return publicRevision(revision)
    },
    async getPreferences() {
      if (!adapter.getPreferences) throw hostError('UNSUPPORTED', 'getPreferences')
      const prefs = await adapter.getPreferences()
      if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs) || !['light','dark','system'].includes(prefs.theme) || typeof prefs.language !== 'string') throw hostError('INVALID_RESPONSE', 'getPreferences')
      if (prefs.documentTheme !== undefined && !DOCUMENT_THEME_MODES.includes(prefs.documentTheme)) throw hostError('INVALID_RESPONSE', 'getPreferences')
      if (prefs.authorName !== undefined && (typeof prefs.authorName !== 'string' || prefs.authorName.length > 100)) throw hostError('INVALID_RESPONSE', 'getPreferences')
      for (const name of ['autoSave', 'showAssistant'] as const) {
        if (prefs[name] !== undefined && typeof prefs[name] !== 'boolean') throw hostError('INVALID_RESPONSE', 'getPreferences')
      }
      const safe: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(prefs)) if (ALLOWED_PREFS.has(key)) safe[key] = value
      return safe as unknown as typeof prefs
    },
  }
}
