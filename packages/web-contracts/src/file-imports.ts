const odfDocumentConversionTargets = { odt: 'docx', ott: 'docx', odp: 'pptx', otp: 'pptx' } as const
export const odfConversionTargets = { ods: 'xlsx', ots: 'xlsx', ...odfDocumentConversionTargets } as const
export const legacyOfficeConversionTargets = { doc: 'docx', dot: 'docx', ppt: 'pptx' } as const
export const hancomConversionTargets = { hwp: 'docx', hwpx: 'docx' } as const
export const officeDocumentConversionTargets = { ...odfDocumentConversionTargets, ...legacyOfficeConversionTargets, ...hancomConversionTargets } as const
export type OfficeDocumentConversionFormat = keyof typeof officeDocumentConversionTargets

export const workspaceConversionTargets = { tsv: 'xlsx', xls: 'xlsx', ...odfConversionTargets, ...legacyOfficeConversionTargets, ...hancomConversionTargets } as const
export type WorkspaceConversionFormat = keyof typeof workspaceConversionTargets

export function workspaceConversionTarget(format: string) {
  return Object.hasOwn(workspaceConversionTargets, format)
    ? workspaceConversionTargets[format as WorkspaceConversionFormat] : undefined
}
