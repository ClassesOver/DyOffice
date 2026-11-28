export const workspaceFileAccept = '.docx,.xlsx,.pptx,.pdf'
export type WorkbookImportFormat = 'csv' | 'xlsm' | 'tsv' | 'xls' | 'ods' | 'ots'

export function workspaceWorkbookImports(capabilities: Record<string,string>): WorkbookImportFormat[] {
  return (['csv','xlsm','tsv','xls','ods','ots'] as const).filter(format => capabilities[format==='xlsm'?'xlsx':`${format}Import`] === 'editable')
}

export function isWorkspaceFileName(name: string, workbookImports: readonly WorkbookImportFormat[] = []): boolean {
  const lower = name.toLowerCase()
  return /\.(docx|xlsx|pptx|pdf)$/.test(lower) || workbookImports.some(format => lower.endsWith(`.${format}`))
}
