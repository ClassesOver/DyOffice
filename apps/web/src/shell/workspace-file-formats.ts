export const workspaceFileAccept = '.docx,.xlsx,.pptx,.pdf'

export function isWorkspaceFileName(name: string, canImportTsv = false): boolean {
  return /\.(docx|xlsx|pptx|pdf)$/i.test(name) || (canImportTsv && /\.tsv$/i.test(name))
}
