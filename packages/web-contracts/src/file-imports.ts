const odfDocumentConversionTargets = { odt: 'docx', ott: 'docx', odp: 'pptx', otp: 'pptx' } as const
export const odfConversionTargets = { ods: 'xlsx', ots: 'xlsx', ...odfDocumentConversionTargets } as const
export const legacyOfficeConversionTargets = { doc: 'docx', dot: 'docx', ppt: 'pptx' } as const
export const hancomConversionTargets = { hwp: 'docx', hwpx: 'docx' } as const
export const officeDocumentConversionTargets = { ...odfDocumentConversionTargets, ...legacyOfficeConversionTargets, ...hancomConversionTargets } as const
export type OfficeDocumentConversionFormat = keyof typeof officeDocumentConversionTargets

export const workspaceConversionTargets = { tsv: 'xlsx', xls: 'xlsx', ...odfConversionTargets, ...legacyOfficeConversionTargets, ...hancomConversionTargets } as const
export type WorkspaceConversionFormat = keyof typeof workspaceConversionTargets
export type ConvertedCopyDestination = { stem?: string; folderId?: string }

export function workspaceConversionTarget(format: string) {
  return Object.hasOwn(workspaceConversionTargets, format)
    ? workspaceConversionTargets[format as WorkspaceConversionFormat] : undefined
}

const importPromptByFormat = {
  doc: 'skipWord97ImportPrompt', dot: 'skipWord97ImportPrompt',
  odt: 'skipOdtImportPrompt', ott: 'skipOdtImportPrompt',
  hwp: 'skipHwpImportPrompt', hwpx: 'skipHwpImportPrompt',
  ods: 'skipOdsImportPrompt', ots: 'skipOdsImportPrompt',
  odp: 'skipOdpImportPrompt', otp: 'skipOdpImportPrompt',
  ppt: 'skipPptImportPrompt',
} as const
export type ImportPromptField = typeof importPromptByFormat[keyof typeof importPromptByFormat]
export const IMPORT_PROMPT_FIELDS = [...new Set(Object.values(importPromptByFormat))]
export type ImportPromptPreferences = Partial<Record<ImportPromptField | 'skipOdfImportPrompt', boolean>>

export function importPromptField(extension: string): ImportPromptField | undefined {
  return Object.hasOwn(importPromptByFormat, extension)
    ? importPromptByFormat[extension as keyof typeof importPromptByFormat] : undefined
}

export function skipsImportPrompt(preferences: ImportPromptPreferences | undefined, field: ImportPromptField): boolean {
  const explicit = preferences?.[field]
  if (typeof explicit === 'boolean') return explicit
  // Existing accounts used one switch for all three OpenDocument families.
  return preferences?.skipOdfImportPrompt === true &&
    (field === 'skipOdtImportPrompt' || field === 'skipOdsImportPrompt' || field === 'skipOdpImportPrompt')
}
