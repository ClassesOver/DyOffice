import { HostError, hostError } from '../../web-contracts/src/errors.ts'
import { isRevisionRef, isSaveInput } from '../../web-contracts/src/api.ts'
import { UNSUPPORTED_CAPABILITIES } from '../../web-contracts/src/host.ts'
import type { BrowserHost, CapabilityCatalog } from '../../web-contracts/src/host.ts'

const CAPABILITIES = new Set(['unsupported', 'read_only', 'editable'])
const ALLOWED_PREFS = new Set(['theme', 'language', 'authorName', 'autoSave', 'showAssistant'])
function nonempty(value: string, field: string): void {
  if (typeof value !== 'string' || !value.length) throw new HostError('INVALID_RESPONSE', `Missing ${field}`)
}
function safeCapabilities(value: unknown): CapabilityCatalog {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw hostError('INVALID_RESPONSE', 'getCapabilities')
  const v = value as Record<string, unknown>
  if (!['docx', 'xlsx', 'pptx', 'pdf'].every(k => CAPABILITIES.has(String(v[k])))) throw hostError('INVALID_RESPONSE', 'getCapabilities')
  return { docx: v.docx, xlsx: v.xlsx, pptx: v.pptx, pdf: v.pdf } as CapabilityCatalog
}

/** Explicit Web adapter: missing methods fail closed rather than pretending desktop IPC works. */
export function createBrowserHost(adapter: Partial<BrowserHost> = {}): BrowserHost {
  return {
    async getCapabilities() {
      if (!adapter.getCapabilities) return UNSUPPORTED_CAPABILITIES
      return safeCapabilities(await adapter.getCapabilities())
    },
    async open(fileId) {
      nonempty(fileId, 'fileId')
      if (!adapter.open) throw hostError('UNSUPPORTED', 'open')
      const result = await adapter.open(fileId)
      if (!result || !isRevisionRef(result.file) || result.file.fileId !== fileId || !['docx','xlsx','pptx','pdf'].includes(result.format) || typeof result.downloadEndpoint !== 'string') throw hostError('INVALID_RESPONSE', 'open')
      return { ...result, capabilities: safeCapabilities(result.capabilities) }
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
      const revision = await adapter.commitSave(input)
      if (!isRevisionRef(revision) || revision.fileId !== input.fileId) throw hostError('INVALID_RESPONSE', 'commitSave')
      return revision
    },
    async getPreferences() {
      if (!adapter.getPreferences) throw hostError('UNSUPPORTED', 'getPreferences')
      const prefs = await adapter.getPreferences()
      if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs) || !['light','dark','system'].includes(prefs.theme) || typeof prefs.language !== 'string') throw hostError('INVALID_RESPONSE', 'getPreferences')
      const safe: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(prefs)) if (ALLOWED_PREFS.has(key)) safe[key] = value
      return safe as unknown as typeof prefs
    },
  }
}
