import {workspaceConversionTargets,type WorkspaceConversionFormat} from '../../../../packages/web-contracts/src/file-imports'

export const workspaceFileAccept = '.docx,.xlsx,.pptx,.pdf'
export type WorkspaceImportFormat = 'csv' | 'xlsm' | WorkspaceConversionFormat

export function workspaceFileImports(capabilities: Record<string,string>): WorkspaceImportFormat[] {
  const formats: WorkspaceImportFormat[] = ['csv','xlsm',...Object.keys(workspaceConversionTargets) as WorkspaceConversionFormat[]]
  return formats.filter(format => capabilities[format==='xlsm'?'xlsx':`${format}Import`] === 'editable')
}

export function isWorkspaceFileName(name: string, fileImports: readonly WorkspaceImportFormat[] = []): boolean {
  const lower = name.toLowerCase()
  return /\.(docx|xlsx|pptx|pdf)$/.test(lower) || fileImports.some(format => lower.endsWith(`.${format}`))
}
