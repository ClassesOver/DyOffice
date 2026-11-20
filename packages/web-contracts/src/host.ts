import type { OpenFileResult, PublicSettings, RevisionRef, SaveInput } from './api.ts'

export type CapabilityState = 'unsupported' | 'read_only' | 'editable'
export type CapabilityCatalog = Readonly<Record<'docx' | 'xlsx' | 'pptx' | 'pdf', CapabilityState> & {pdfEditor?:CapabilityState}>
export interface BrowserHost {
  getCapabilities(): Promise<CapabilityCatalog>
  open(fileId: string): Promise<OpenFileResult>
  readBytes(fileId: string, revision: string): Promise<Uint8Array>
  stageSave(bytes: Uint8Array, fileId: string): Promise<{ uploadId: string }>
  commitSave(input: SaveInput): Promise<RevisionRef>
  getPreferences(): Promise<PublicSettings>
}
export const UNSUPPORTED_CAPABILITIES: CapabilityCatalog = Object.freeze({ docx: 'unsupported', xlsx: 'unsupported', pptx: 'unsupported', pdf: 'unsupported' })
