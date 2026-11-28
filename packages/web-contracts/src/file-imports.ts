export const odfConversionTargets = {
  ods: 'xlsx', ots: 'xlsx', odt: 'docx', ott: 'docx', odp: 'pptx', otp: 'pptx',
} as const

export const workspaceConversionTargets = { tsv: 'xlsx', xls: 'xlsx', ...odfConversionTargets } as const
export type WorkspaceConversionFormat = keyof typeof workspaceConversionTargets

export function workspaceConversionTarget(format: string) {
  return Object.hasOwn(workspaceConversionTargets, format)
    ? workspaceConversionTargets[format as WorkspaceConversionFormat] : undefined
}
